// Replays refund-all-for-fraud-worker.golden.json (scripts/golden/refund-all-for-fraud-worker.rb): RefundAllForFraudWorker run by the
// real app as a Sidekiq job. Node reads the same sales, queues the same RefundPurchaseForFraudWorker items and leaves the same comment.
// The job carries a unique-jobs lock, so this runs against a real Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/31 npm test.
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
import { refundAllForFraudWorkerWith } from "./refund-all-for-fraud-worker.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  args: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/refund-all-for-fraud-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

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
  const handler = refundAllForFraudWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error };
}

describe.skipIf(!url)("RefundAllForFraudWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, error } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }
});
