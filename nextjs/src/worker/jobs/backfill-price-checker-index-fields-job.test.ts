// Replays backfill-price-checker-index-fields-job.golden.json (scripts/golden/backfill-price-checker-index-fields-job.rb):
// BackfillPriceCheckerIndexFieldsJob run by the real app as a Sidekiq job. Node sends the same Elasticsearch requests (the scroll,
// each page, the clear) and schedules the same SendToElasticsearchWorker jobs. The jobs carry a unique-jobs lock, so this runs
// against a real Redis like product-search-jobs.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test. It is flushed between cases.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { esRecorder, plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { backfillPriceCheckerIndexFieldsJobWith } from "./backfill-price-checker-index-fields-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  redis: RedisSnapshot;
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/backfill-price-checker-index-fields-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = backfillPriceCheckerIndexFieldsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

describe.skipIf(!url)("BackfillPriceCheckerIndexFieldsJob", () => {
  const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  for (const c of golden.cases) {
    it(c.name, async () => {
      await redis.flushdb();
      const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
      const runtime = createJobsRuntime({
        sidekiqRedis: redis,
        bullmqRedis: redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
      } catch (e) {
        error = e;
      } finally {
        es.restore();
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(es.requests).toEqual(c.es);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
      await runtime.close();
    });
  }
});
