// Replays dispatch-product-publish-schedules-job.golden.json (scripts/golden/dispatch-product-publish-schedules-job.rb): the job run by
// the real app as a Sidekiq job. Node sends the three reads Rails sent with the same cut-offs and queues the same pushes; a stale claim
// goes back to Rails after the scan with nothing pushed. The notice jobs carry a unique-jobs lock, so this runs against a real Redis like
// retry-stripe-jp-address-resyncs-job.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/62 npm test. It is flushed between cases.
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
import { dispatchProductPublishSchedulesJobWith } from "./dispatch-product-publish-schedules-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/dispatch-product-publish-schedules-job.golden.json", import.meta.url), "utf8"),
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
  const handler = dispatchProductPublishSchedulesJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([] as JsonValue[], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { sql, error };
}

describe.skipIf(!url)("DispatchProductPublishSchedulesJob", () => {
  for (const c of golden.cases.filter((c) => !c.hands_back)) {
    it(c.name, async () => {
      const { sql, error } = await run(c);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
    });
  }

  for (const c of golden.cases.filter((c) => c.hands_back)) {
    it(`hands ${c.name} back after the scan, before any push`, async () => {
      const { sql, error } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, sql.log.length));
      expect(sql.log).toHaveLength(2);
      expect(await snapshotRedis(redis)).toEqual({});
    });
  }
});
