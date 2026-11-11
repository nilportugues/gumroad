// Replays retry-stripe-jp-address-resyncs-job.golden.json (scripts/golden/retry-stripe-jp-address-resyncs-job.rb):
// RetryStripeJpAddressResyncsJob run by the real app as a Sidekiq job. Node sends the batch statements Rails sent, watches the replica
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
import { retryStripeJpAddressResyncsJobWith } from "./retry-stripe-jp-address-resyncs-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  replica_watches: number;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/retry-stripe-jp-address-resyncs-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Ruby's JSON::ParserError message is not ported, so the job is handed back.
const HANDED_BACK = new Set(["json data that is not json"]);

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
  const handler = retryStripeJpAddressResyncsJobWith({
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

describe.skipIf(!url)("RetryStripeJpAddressResyncsJob", () => {
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

  for (const [name, json] of [
    ["a year past 9999", '{"address_resync_at":"10000-01-01T00:00:00Z"}'],
    ["two out of range components", '{"address_resync_at":"2026-13-32T00:00:00Z"}'],
  ] as [string, string][]) {
    it(`hands a retry time with ${name} back before any push`, async () => {
      const base = golden.cases.find((c) => c.name === "a request never retried")!;
      const statements = structuredClone(base.statements);
      statements[0]!.result!.rows![0]![8] = json;
      const { sql, error } = await run({ ...base, statements });

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(await snapshotRedis(redis)).toEqual({});
    });
  }
});
