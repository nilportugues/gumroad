// Replays stripe-account-events.golden.json (scripts/golden/stripe-account-events.rb): HandleStripeEventWorker run by the real app as a
// Sidekiq job for `capability.updated` and the `account.updated` of a standard account of a connected account. Node sends the
// statements Rails sent (the lookup, the clearing save of the mismatch markers) and pushes the Sidekiq items Rails pushed (the
// availability refresh with its unique-jobs lock).
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stripe-account-events.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const handleStripeEventWorker = handleStripeEventWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

// The availability refresh is a unique job, whose lock is a Lua script: those cases need a Redis.
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

function runtimeOn(redis: Redis) {
  return createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

async function run(args: JsonValue[], redis: Redis): Promise<Error | null> {
  try {
    await asSidekiqJob(() => handleStripeEventWorker(args, contextFor(runtimeOn(redis))), golden.now);
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe("HandleStripeEventWorker for capability.updated and account.updated", () => {
  for (const c of golden.cases) {
    it.skipIf(takesLocks(c) && !url)(c.name, async () => {
      const sql = sqlReplay(c.statements);
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
      const error = await run(c.args, sidekiqRedis);
      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds(await snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }
});

describe("events Node leaves to Rails", () => {
  const capability = { id: "evt_1", type: "capability.updated", account: "acct_1" };
  const updated = { id: "evt_2", type: "account.updated", account: "acct_1" };
  const object = (extra: Record<string, unknown>) => ({ data: { object: extra } });
  const standard = { object: "account", id: "acct_1", type: "standard" };

  it.each([
    ["a capability event without data", capability],
    ["a capability whose object is an account", { ...capability, ...object({ object: "account", account: "acct_1" }) }],
    ["a capability whose account is not a String", { ...capability, ...object({ object: "capability", account: 7 }) }],
    ["an account event without data", updated],
    ["an account event whose id is not a String", { ...updated, ...object({ ...standard, id: 7 }) }],
    ["an account of type custom", { ...updated, ...object({ ...standard, type: "custom" }) }],
    ["an account of type express", { ...updated, ...object({ ...standard, type: "express" }) }],
    ["previous_attributes that is not an object", { ...updated, data: { object: standard, previous_attributes: "x" } }],
    [
      "a capability.updated variant",
      { ...capability, type: "capability.updated.v2", ...object({ object: "capability", account: "acct_1" }) },
    ],
    ["an account.updated variant", { ...updated, type: "account.updated.v2", ...object(standard) }],
  ])("%s is handed back before any statement or job", async (_name, params) => {
    const recording = recordingSidekiqRedis();
    const sql = sqlReplay([]);
    const error = await run([params as JsonValue], recording.redis);
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(recording.snapshot()).toEqual({});
  });

  it("a capability of a Japanese account is handed back after the lookup and before any job", async () => {
    const c = golden.cases.find((c) => c.name === "capability.updated of a Connect account in another country")!;
    const [lookup] = c.statements as unknown as { result: { fields: string[]; rows: unknown[][] } }[];
    const countryIndex = lookup!.result.fields.indexOf("country");
    const japanese = {
      ...lookup,
      result: {
        ...lookup!.result,
        rows: lookup!.result.rows.map((r) => r.map((v, i) => (i === countryIndex ? "JP" : v))),
      },
    };
    const sql = sqlReplay([japanese as unknown as Statement]);
    const recording = recordingSidekiqRedis();
    const error = await run(c.args, recording.redis);
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected);
    expect(recording.snapshot()).toEqual({});
  });
});
