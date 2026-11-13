// Replays retry-stripe-rejected-payout-setups-job.golden.json (scripts/golden/retry-stripe-rejected-payout-setups-job.rb):
// RetryStripeRejectedPayoutSetupsJob run by the real app as a Sidekiq job. Node sends the batch statements Rails sent, judges each
// note's json_data the way Rails does (including the Ruby errors an odd value raises), queues the same per-seller jobs and ends with
// the inline address resync. Those carry a unique-jobs lock, so this runs against a real Redis:
// JOBS_REDIS_URL=redis://127.0.0.1:6379/31 npm test. It is flushed between cases.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { retryStripeRejectedPayoutSetupsJobWith } from "./retry-stripe-rejected-payout-setups-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  replica_watches: number;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/retry-stripe-rejected-payout-setups-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// json_data that Node does not read the way Ruby does, and a retry time that is not a string.
const HANDED_BACK = new Set([
  "json data that is not json",
  "a retry time that is a number",
  "a retry time that is true",
]);

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

async function run(c: Case) {
  await redis.flushdb();
  const sql = sqlReplay(c.statements);
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let watches = 0;
  const handler = retryStripeRejectedPayoutSetupsJobWith({
    now: () => new Date(Math.round(golden.now * 1000)),
    watchReplicaLag: () => Promise.resolve(void watches++),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([] as JsonValue[], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error, watches };
}

describe.skipIf(!url)("RetryStripeRejectedPayoutSetupsJob", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, error, watches } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_watches);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before any push`, async () => {
      const { sql, error } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(await snapshotRedis(redis)).toEqual({});
    });
  }
});
