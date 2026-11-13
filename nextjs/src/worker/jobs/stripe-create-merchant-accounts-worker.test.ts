// Replays stripe-create-merchant-accounts-worker.golden.json (scripts/golden/stripe-create-merchant-accounts-worker.rb):
// StripeCreateMerchantAccountsWorker run by the real app as a Sidekiq job. Node sends the batch statements Rails sent, watches the replica
// lag once per batch, judges each request's json_data the way Rails does (including the Ruby errors an odd value raises) and queues
// the same per-seller jobs. Those carry a unique-jobs lock, so this runs against a real Redis like
// update-sales-related-products-infos-job.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/31 npm test. It is flushed between cases.
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
import { stripeCreateMerchantAccountsWorkerWith } from "./stripe-create-merchant-accounts-worker.ts";

type Case = {
  name: string;
  now: unknown;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/stripe-create-merchant-accounts-worker.golden.json", import.meta.url), "utf8"),
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

// A whole-second time parses as Ruby's Float wrapper.
const secondsOf = (c: Case) => (typeof c.now === "number" ? c.now : (c.now as { value: number }).value);

async function run(c: Case) {
  const now = secondsOf(c);
  await redis.flushdb();
  const sql = sqlReplay(c.statements);
  const runtime = createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => now,
    newJid: sequentialJids(),
  });
  const handler = stripeCreateMerchantAccountsWorkerWith({ now: () => new Date(Math.round(now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([] as JsonValue[], contextFor(runtime)), now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error };
}

describe.skipIf(!url)("StripeCreateMerchantAccountsWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, error } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }
});
