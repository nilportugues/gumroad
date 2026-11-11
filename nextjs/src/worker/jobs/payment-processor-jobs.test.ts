// Replays payment-processor-jobs.golden.json (scripts/golden/payment-processor-jobs.rb): each job run
// by the real app against MySQL as a Sidekiq job. Node must send the statements Rails sent, given the
// same answers, queue the same Sidekiq payloads and fail with the same errors. The jobs Node hands back
// stop where Rails' first write or payment processor call would be, which the golden marks with a
// stand-in exception. The balance stats cases read and write Redis, so they need JOBS_REDIS_URL (a
// scratch database) and are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { StripeClient, setStripeClientForTesting, type TransportRequest } from "../../server/stripe/client.ts";
import { stripeConfigFromEnv } from "../../server/stripe/config.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  executeScheduledPayoutsJobWith,
  failAbandonedPurchaseWorkerWith,
  handleStripeEventWorker,
  handlePayoutReversedWorker,
  largeSellersUpdateUserBalanceStatsCacheWorkerWith,
  lowBalanceFraudCheckWorker,
  syncStuckPayoutsJobWith,
  updatePayoutStatusWorker,
} from "./payment-processor-jobs.ts";
import type { JobHandler } from "./types.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  hands_back: boolean;
  batch_size?: number;
  stripe: { responses: [number, Record<string, string>, string][]; requests: Request[] };
};
type Request = { method: string; path: string; query: string | null; body: string | null };
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/payment-processor-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const now = () => new Date(Math.round(golden.now * 1000));

// The golden parser keeps a score such as 1793795700.0 as a RubyFloat; Node's double is the same number.
const plain = (value: unknown): unknown =>
  value instanceof RubyFloat
    ? value.value
    : Array.isArray(value)
      ? value.map(plain)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
        : value;

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

async function restore(redis: Redis, before: RedisSnapshot) {
  await redis.flushdb();
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") await redis.set(key, String(entry.value));
    else if (entry.type === "set") await redis.sadd(key, ...(entry.value as string[]));
    else throw new Error(`cannot restore a ${entry.type}`);
  }
}

// Stripe answered from the script the golden recorded; any request outside it fails the case.
function fakeStripe(c: Case) {
  const requests: Request[] = [];
  const script = [...c.stripe.responses];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test", maxNetworkRetries: 0 },
    sleep: async () => {},
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      requests.push({
        method: request.method.toUpperCase(),
        path: path!,
        query: query.length ? query.join("?") : null,
        body: request.body ?? null,
      });
      const [status, headers, body] = script.shift() ?? [500, {}, "no scripted response"];
      return {
        status,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        body,
      };
    },
  });
  return { client, requests };
}

// Ruby's Net::HTTP sends `?` with an empty query on a GET.
const normalize = (r: Request) => ({
  ...r,
  query: r.query === "" ? null : r.query,
  body: r.body === "" ? null : r.body,
});

afterEach(() => setStripeClientForTesting(undefined));

function handlerFor(c: Pick<Case, "job" | "batch_size">): JobHandler {
  const deps = { now };
  switch (c.job) {
    case "ExecuteScheduledPayoutsJob":
      return executeScheduledPayoutsJobWith(deps);
    case "SyncStuckPayoutsJob":
      return syncStuckPayoutsJobWith(deps);
    case "UpdatePayoutStatusWorker":
      return updatePayoutStatusWorker;
    case "FailAbandonedPurchaseWorker":
      return failAbandonedPurchaseWorkerWith(deps);
    case "LowBalanceFraudCheckWorker":
      return lowBalanceFraudCheckWorker;
    case "HandlePayoutReversedWorker":
      return handlePayoutReversedWorker;
    case "HandleStripeEventWorker":
      return handleStripeEventWorker;
    case "LargeSellersUpdateUserBalanceStatsCacheWorker":
      return largeSellersUpdateUserBalanceStatsCacheWorkerWith(deps, {
        redis: () => realRedis!,
        pushBulkBatchSize: c.batch_size ?? 1_000,
      });
    default:
      throw new Error(`no handler for ${c.job}`);
  }
}

const usesRedis = (c: Case) => c.job === "LargeSellersUpdateUserBalanceStatsCacheWorker";

describe("payment processor jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(usesRedis(c) && !url)(`${c.job}: ${c.name}`, async () => {
      const sql = sqlReplay(c.statements);
      const stripe = fakeStripe(c);
      setStripeClientForTesting(stripe.client);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (usesRedis(c)) {
        await restore(realRedis!, c.redis_before ?? {});
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = async () => recording.snapshot();
      }
      const runtime = createJobsRuntime({
        sidekiqRedis,
        bullmqRedis: sidekiqRedis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handlerFor(c)(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      }

      expect(sql.log).toEqual(sql.expected);
      expect(stripe.requests.map(normalize)).toEqual(c.stripe.requests.map(normalize));
      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(plain(await snapshot())).toEqual(plain(c.redis));
    });
  }
});

describe("arguments Node does not reproduce", () => {
  const runtimeFor = () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    return { recording, runtime };
  };
  const bad: [string, JsonValue[]][] = [
    ["UpdatePayoutStatusWorker", [null]],
    ["UpdatePayoutStatusWorker", ["abc"]],
    ["FailAbandonedPurchaseWorker", [null]],
    ["LowBalanceFraudCheckWorker", [1.5]],
    ["SyncStuckPayoutsJob", [null]],
    ["SyncStuckPayoutsJob", [7]],
    ["HandlePayoutReversedWorker", [7, null, "acct_1"]],
    ["HandlePayoutReversedWorker", [7.5, "po_1", "acct_1"]],
    ["HandleStripeEventWorker", [null]],
    ["HandleStripeEventWorker", ["charge.succeeded"]],
    ["HandleStripeEventWorker", [[{ type: "charge.succeeded" }]]],
  ];
  for (const [job, args] of bad) {
    it(`${job} hands ${JSON.stringify(args)} back to Rails before any statement`, async () => {
      const sql = sqlReplay([]);
      const { recording, runtime } = runtimeFor();
      await expect(
        asSidekiqJob(() => handlerFor({ job })(args, contextFor(runtime)), golden.now),
      ).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(sql.log).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a payload with the wrong number of arguments as Ruby does", async () => {
    await expect(
      handlerFor({ job: "UpdatePayoutStatusWorker" })([1, 2], contextFor(runtimeFor().runtime)),
    ).rejects.toThrow("wrong number of arguments (given 2, expected 1)");
  });
});

describe("HandleStripeEventWorker events for the platform account", () => {
  const PLATFORM = "acct_platform_example";
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.STRIPE_PLATFORM_ACCOUNT_ID;
    process.env.STRIPE_PLATFORM_ACCOUNT_ID = PLATFORM;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.STRIPE_PLATFORM_ACCOUNT_ID;
    else process.env.STRIPE_PLATFORM_ACCOUNT_ID = previous;
  });

  const run = (params: JsonValue) => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    return asSidekiqJob(() => handleStripeEventWorker([params], contextFor(runtime)), golden.now);
  };

  const finishes: [string, JsonValue][] = [
    ["account.updated without an account", { type: "account.updated" }],
    ["capability.updated with a blank account", { type: "capability.updated", account: "" }],
    ["payout.paid with a blank user_id and no account", { type: "payout.paid", user_id: "  " }],
    ["payout.paid for the platform account", { type: "payout.paid", account: PLATFORM }],
    [
      "account.application.deauthorized for the platform user_id",
      { type: "account.application.deauthorized", user_id: PLATFORM, account: "acct_other_example" },
    ],
  ];
  for (const [name, params] of finishes) {
    it(`finishes ${name} without a statement`, async () => {
      const sql = sqlReplay([]);
      await expect(run(params)).resolves.toBeUndefined();
      expect(sql.log).toEqual([]);
    });
  }

  const handsBack: [string, JsonValue][] = [
    ["payout.paid for a connected account", { type: "payout.paid", account: "acct_connected_example" }],
    [
      "account.updated whose user_id is a connected account",
      { type: "account.updated", user_id: "acct_connected_example", account: PLATFORM },
    ],
    [
      "account.application.deauthorized for a connected account",
      { type: "account.application.deauthorized", account: "acct_connected_example" },
    ],
    ["a charge event for the platform account", { type: "charge.succeeded", account: PLATFORM }],
    ["a refund event for the platform account", { type: "refund.updated" }],
    ["a payment_intent event for the platform account", { type: "payment_intent.succeeded" }],
    ["a customer.subscription event for the platform account", { type: "customer.subscription.updated" }],
    ["a checkout.session.completed event for the platform account", { type: "checkout.session.completed" }],
  ];
  for (const [name, params] of handsBack) {
    it(`hands ${name} back to Rails`, async () => {
      const sql = sqlReplay([]);
      await expect(run(params)).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(sql.log).toEqual([]);
    });
  }

  it("finishes an unhandled type as before", async () => {
    await expect(run({ type: "invoice.paid", account: "acct_connected_example" })).resolves.toBeUndefined();
  });
});

describe("a Redis that fails", () => {
  it("queues nobody when the exclusion set cannot be read", async () => {
    const sql = sqlReplay([]);
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const broken = {
      get: () => Promise.reject(new Error("connection refused")),
      smembers: () => Promise.reject(new Error("connection refused")),
    } as unknown as Redis;
    await asSidekiqJob(
      () =>
        largeSellersUpdateUserBalanceStatsCacheWorkerWith({ now }, { redis: () => broken })([], contextFor(runtime)),
      golden.now,
    );
    expect(sql.log).toEqual([]);
    expect(recording.snapshot()).toEqual({});
  });
});
