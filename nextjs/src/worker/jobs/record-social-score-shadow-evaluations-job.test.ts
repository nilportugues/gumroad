// Replays record-social-score-shadow-evaluations-job.golden.json (scripts/golden/record-social-score-shadow-evaluations-job.rb): the job run
// by the real app as a Sidekiq job with the scoring service answering nil. Node reads the same verified user slices with a replica lag check
// before each and hands the job back right after the first slice that holds a user; a date other than YYYY-MM-DD hands back before any
// statement. The cron tick pushes the dated re-enqueue under a unique-jobs lock, so those two cases need a real Redis like
// backfill-price-checker-index-fields-job.test.ts: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test (flushed between cases).
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import { asSidekiqJob, contextFor, rubyRuntimeRegistry, sequentialJids, snapshotRedis } from "./__fixtures__/golden.ts";
import { loadGuardGolden, describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { recordSocialScoreShadowEvaluationsJobWith } from "./record-social-score-shadow-evaluations-job.ts";

const NOT_ISO_DATES = new Set([
  "a date with a time",
  "a date that is not a date",
  "a date of the wrong calendar day",
  "a date written out",
  "a date given as an integer",
]);
const CRON_TICKS = new Set(["the cron tick with no date", "the cron tick with a nil date"]);
const file = "record-social-score-shadow-evaluations-job.golden.json";

describeGuardedJob({
  title: "RecordSocialScoreShadowEvaluationsJob",
  file,
  make: (deps) => recordSocialScoreShadowEvaluationsJobWith(deps),
  reached: (c) => (c.processed as number[]).length > 0,
  castBefore: (c) => NOT_ISO_DATES.has(c.name),
  skip: (c) => CRON_TICKS.has(c.name),
});

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

describe.skipIf(!url)("RecordSocialScoreShadowEvaluationsJob cron tick", () => {
  const golden = loadGuardGolden(file);
  const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  for (const c of golden.cases.filter((c) => CRON_TICKS.has(c.name))) {
    it(`${c.name} pushes the dated job under its lock`, async () => {
      await redis.flushdb();
      const runtime = createJobsRuntime({
        sidekiqRedis: redis,
        bullmqRedis: redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const handler = recordSocialScoreShadowEvaluationsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) });
      await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);

      expect(plain(await snapshotRedis(redis))).toEqual(plain(c.redis));
      await runtime.close();
    });
  }
});
