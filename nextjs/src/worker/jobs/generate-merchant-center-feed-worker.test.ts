// Replays generate-merchant-center-feed-worker.golden.json (scripts/golden/generate-merchant-center-feed-worker.rb):
// GenerateMerchantCenterFeedWorker run by the real app as a Sidekiq job. Node takes, renews and releases the same Redis lock,
// retries five minutes out the same way and stops on the kill switch; a run that would publish a unit (`hands_back`) leaves Redis as
// it found it and is handed back. A real scratch Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test (flushed between cases).
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { evaluateFeature, parseGateValues } from "../../server/infra/flipper.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

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
import { generateMerchantCenterFeedWorkerWith } from "./generate-merchant-center-feed-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  calls: Record<string, string>;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/generate-merchant-center-feed-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

async function seed(before: RedisSnapshot) {
  for (const [key, entry] of Object.entries(before)) {
    if (entry.type === "string") await redis.set(key, entry.value as string);
    else if (entry.type === "hash") await redis.hset(key, entry.value as Record<string, string>);
    else if (entry.type === "set") await redis.sadd(key, ...(entry.value as string[]));
    else throw new Error(`cannot seed a ${entry.type}`);
  }
}

// MerchantCenterFeedRun#kill_switch? as the golden scripted it: the Nth call engages the switch, or first hands the lock to another run.
function killSwitch(c: Case) {
  let calls = 0;
  return async (name: string) => {
    calls += 1;
    const step = c.calls[String(calls)];
    if (step === "engage") return true;
    if (step === "steal") await redis.set("merchant_center_feed_lock", "another-run-token");
    return evaluateFeature(name, parseGateValues((c.redis_before[name]?.value ?? {}) as Record<string, string>), null);
  };
}

const withoutJobIds = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID"),
  ) as RedisSnapshot;
const withoutSetup = (after: RedisSnapshot, before: RedisSnapshot) =>
  Object.fromEntries(
    Object.entries(after).filter(([key, entry]) => JSON.stringify(before[key]) !== JSON.stringify(entry)),
  );

// Arguments Node does not reproduce (a string, a float, nil) hand back before it touches anything.
const handsBackEarly = (c: Case) => c.args.some((arg) => !(typeof arg === "number" && Number.isInteger(arg)));

describe.skipIf(!url)("GenerateMerchantCenterFeedWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      await redis.flushdb();
      await seed(c.redis_before);
      const early = handsBackEarly(c);
      const sql = sqlReplay(c.statements);
      const pushes = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: pushes.redis,
        bullmqRedis: pushes.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const handler = generateMerchantCenterFeedWorkerWith(
        { now: () => new Date(Math.round(golden.now * 1000)), uuid: () => "run-token" },
        { redis: () => redis, killSwitchEngaged: killSwitch(c) },
      );
      let error: Error | null = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
      } catch (e) {
        error = e as Error;
      }

      const left = withoutSetup(plain(await snapshotRedis(redis)) as RedisSnapshot, c.redis_before);
      if (early || c.hands_back) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(pushes.snapshot()).toEqual({});
        expect(left).toEqual(early ? {} : withoutSetup(plain(c.redis) as RedisSnapshot, c.redis_before));
        expect(sql.log).toEqual(early ? [] : sql.expected);
        return;
      }
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(withoutJobIds({ ...left, ...pushes.snapshot() })).toEqual(
        withoutJobIds(plain(withoutSetup(c.redis, c.redis_before)) as RedisSnapshot),
      );
    });
  }
});
