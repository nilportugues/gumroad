// Replays stripe-account-deauthorized.golden.json (scripts/golden/stripe-account-deauthorized.rb): HandleStripeEventWorker run by the real
// app as a Sidekiq job for the `account.application.deauthorized` events of a connected account. Node sends the statements Rails sent
// (the lookup, the two saves of `delete_charge_processor_account!`, the seller read), pushes the Sidekiq items Rails pushed (the
// callbacks of the saves and the critical-queue mail) and fails with Rails' error when the seller is missing after the delete.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

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
import { handleStripeEventWorkerWith } from "./payment-processor-jobs.ts";

const flipper = vi.hoisted(() => ({ merchantMigration: false }));
vi.mock("../../server/infra/flipper.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/infra/flipper.ts")>()),
  isFeatureEnabled: () => Promise.resolve(flipper.merchantMigration),
}));

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  merchant_migration: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stripe-account-deauthorized.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// ActiveJob's job_id is a random UUID in production; the generator drew them in push order.
const handleStripeEventWorker = handleStripeEventWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

// The recommendability refresh the account saves enqueue is a unique job, whose lock is a Lua script: those cases need a Redis.
const takesLocks = (c: Case) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));
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

// Rails rewrites a NULL json_data to {} in the first save; Node hands the job back right after the lookup instead.
const HANDED_BACK = new Set(["an account with no json_data"]);

describe("HandleStripeEventWorker for a deauthorized connected account", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c) && !url)(c.name, async () => {
      flipper.merchantMigration = c.merchant_migration;
      const handedBack = HANDED_BACK.has(c.name);
      const sql = sqlReplay(handedBack ? c.statements.slice(0, 1) : c.statements);
      let sidekiqRedis: Redis;
      let snapshot: () => Promise<RedisSnapshot>;
      if (takesLocks(c)) {
        await realRedis!.flushdb();
        sidekiqRedis = realRedis!;
        snapshot = () => snapshotRedis(realRedis!);
      } else {
        const recording = recordingSidekiqRedis();
        sidekiqRedis = recording.redis;
        snapshot = () => Promise.resolve(recording.snapshot());
      }
      const jobs = createJobsRuntime({
        sidekiqRedis,
        bullmqRedis: sidekiqRedis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handleStripeEventWorker(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (handedBack) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected);
        expect(await snapshot()).toEqual({});
        return;
      }
      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(await snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }
});

describe("deauthorizations Node leaves to Rails", () => {
  const run = async (params: JsonValue) => {
    const recording = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const sql = sqlReplay([]);
    let error: Error | null = null;
    try {
      await asSidekiqJob(() => handleStripeEventWorker([params], contextFor(jobs)), golden.now);
    } catch (e) {
      error = e as Error;
    }
    return { error, sql, pushed: recording.snapshot() };
  };

  it("a seller on the merchant_migration feature is handed back before any statement but the lookup", async () => {
    flipper.merchantMigration = true;
    const c = golden.cases.find((c) => c.name === "a Connect account of a seller with the link flag off")!;
    const sql = sqlReplay(c.statements.slice(0, 1));
    const recording = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    let error: Error | null = null;
    try {
      await asSidekiqJob(() => handleStripeEventWorker(c.args, contextFor(jobs)), golden.now);
    } catch (e) {
      error = e as Error;
    }
    flipper.merchantMigration = false;
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });

  it.each([
    ["an account id that is not a String", { type: "account.application.deauthorized", account: 7 }],
    [
      "a type that only starts with the deauthorization",
      { type: "account.application.deauthorized.v2", account: "acct_1" },
    ],
  ])("%s is handed back before any statement", async (_name, params) => {
    const { error, sql, pushed } = await run(params as JsonValue);
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(pushed).toEqual({});
  });
});
