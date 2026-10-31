// Replays lift-platform-stripe-pause.golden.json (scripts/golden/lift-platform-stripe-pause.rb): the
// real job run by the app against MySQL, with Stripe answered by a capture server. Node must send the
// same statements and Stripe requests, given the same answers. Headers are client.test.ts's concern.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setSellerProfileCacheForTesting } from "../../server/models/seller-profile.ts";
import { execute } from "../../server/models/sql.ts";
import { resetUserCollaborators, setUserCollaborators } from "../../server/models/user.ts";
import { StripeClient, setStripeClientForTesting, type TransportRequest } from "../../server/stripe/client.ts";
import { stripeConfigFromEnv } from "../../server/stripe/config.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import {
  liftPlatformStripePauseJobRetriesExhaustedWith,
  liftPlatformStripePauseJobRetryIn,
  liftPlatformStripePauseJobWith,
  TransfersNotActiveYet,
} from "./lift-platform-stripe-pause-job.ts";

type Request = { method: string; path: string; query: string | null; body: string | null };
type LiftCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  stripe: { responses: [number, Record<string, string>, string][]; requests: Request[] };
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/lift-platform-stripe-pause.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  retry_in: [number, boolean, number | null][];
  cases: LiftCase[];
};
const now = () => new Date(Math.round(golden.now * 1000));
const transfersError = () => new TransfersNotActiveYet("Stripe has not turned transfers back on for the account.");

// What each case ran, when it was not `perform(*args)`.
const RUNS: Record<string, (context: ReturnType<typeof contextFor>) => Promise<unknown>> = {
  "retries exhausted: abandons a pending lift and keeps the hold": (context) =>
    liftPlatformStripePauseJobRetriesExhaustedWith(now)({ args: [5] } as unknown as SidekiqItem, transfersError(), context),
  "retries exhausted on another error only abandons": (context) =>
    liftPlatformStripePauseJobRetriesExhaustedWith(now)({ args: [5] } as unknown as SidekiqItem, new Error("boom"), context),
  "retries exhausted for a missing seller": (context) =>
    liftPlatformStripePauseJobRetriesExhaustedWith(now)({ args: [404] } as unknown as SidekiqItem, transfersError(), context),
};
// The Ruby case flipped the row from inside Stripe::Account.retrieve.
const AFTER_STRIPE_REQUEST: Record<string, () => Promise<unknown>> = {
  "a seller flagged while Stripe answered is not lifted": () =>
    execute(Prisma.sql`UPDATE \`users\` SET \`users\`.\`user_risk_state\` = 'flagged_for_fraud' WHERE \`users\`.\`id\` = 5`),
};

function fakeStripe(c: LiftCase) {
  const requests: Request[] = [];
  const script = [...c.stripe.responses];
  const client = new StripeClient({
    config: { ...stripeConfigFromEnv(), apiKey: "sk_test_golden", apiBase: "http://stripe.test", maxNetworkRetries: 0 },
    sleep: async () => {},
    transport: async (request: TransportRequest) => {
      const [path, ...query] = request.url.replace("http://stripe.test", "").split("?");
      requests.push({ method: request.method.toUpperCase(), path: path!, query: query.length ? query.join("?") : null, body: request.body ?? null });
      const [status, headers, body] = script.shift() ?? [500, {}, "no scripted response"];
      await AFTER_STRIPE_REQUEST[c.name]?.();
      return { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body };
    },
  });
  return { client, requests };
}

// Ruby's Net::HTTP sends `?` with an empty query on a GET.
const normalize = (r: Request) => ({ ...r, query: r.query === "" ? null : r.query, body: r.body === "" ? null : r.body });

afterEach(() => {
  setStripeClientForTesting(undefined);
  resetUserCollaborators();
});

describe("LiftPlatformStripePauseJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const stripe = fakeStripe(c);
      setStripeClientForTesting(stripe.client);
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({ sidekiqRedis: recording.redis, bullmqRedis: recording.redis, registry: rubyRuntimeRegistry(), now: () => golden.now, newJid: sequentialJids() });
      const cache: [string, string][] = [];
      setSellerProfileCacheForTesting({ delete: async (name) => void cache.push(["cache_delete", name]) });
      setUserCollaborators({ now });
      let error: unknown = null;
      try {
        const context = contextFor(runtime);
        await asSidekiqJob(() => (RUNS[c.name] ? RUNS[c.name]!(context) : liftPlatformStripePauseJobWith({ now })(c.args, context)), golden.now);
      } catch (e) {
        error = e;
      }
      expect(sql.log).toEqual(sql.expected);
      expect(stripe.requests.map(normalize)).toEqual(c.stripe.requests.map(normalize));
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(cache).toEqual(c.cache);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  it("waits minutes between transfers retries and leaves other errors to Sidekiq's backoff", () => {
    for (const [count, transfers, seconds] of golden.retry_in) {
      expect(liftPlatformStripePauseJobRetryIn(count, transfers ? transfersError() : new Error("boom"), {} as SidekiqItem) ?? null).toBe(seconds);
    }
  });
});
