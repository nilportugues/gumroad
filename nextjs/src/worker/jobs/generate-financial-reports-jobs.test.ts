// Replays generate-financial-reports-jobs.golden.json (scripts/golden/generate-financial-reports-jobs.rb):
// GenerateFinancialReportsForPreviousQuarterJob and GenerateFinancialReportsForPreviousMonthJob run by the real app as Sidekiq jobs, in
// production (they enqueue the report jobs, whose unique-jobs locks are real Redis state) and out of it, and the block of their
// sidekiq_retries_exhausted. A real scratch Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test (flushed between cases).
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import { type JsonValue, RubyFloat, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";
import { plain } from "../../server/search/__fixtures__/job-harness.ts";

import {
  contextFor,
  asSidekiqJob,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { financeReportJobWith, financeReportRetriesExhaustedWith } from "./finance-report-jobs.ts";
import {
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_MONTH_JOB,
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_QUARTER_JOB,
} from "./generate-financial-reports-jobs.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  case_now?: number | RubyFloat;
  production?: boolean;
  hook?: boolean;
  item?: Record<string, JsonValue>;
  exception?: { class: string; message: string };
  error: { class: string; message: string } | null;
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/generate-financial-reports-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const JOBS = [
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_QUARTER_JOB,
  GENERATE_FINANCIAL_REPORTS_FOR_PREVIOUS_MONTH_JOB,
];
const jobFor = (name: string) => JOBS.find((job) => job.name === name)!;

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (!url) return;
  await redis.flushdb();
  redis.disconnect();
});

const withoutJobIds = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID"),
  ) as RedisSnapshot;

function runtimeOn(now: number) {
  return createJobsRuntime({
    sidekiqRedis: redis,
    bullmqRedis: redis,
    registry: rubyRuntimeRegistry(),
    now: () => now,
    newJid: sequentialJids(),
  });
}

describe.skipIf(!url)("financial report fan-out jobs", () => {
  for (const c of golden.cases.filter((candidate) => !candidate.hook)) {
    it(c.name, async () => {
      await redis.flushdb();
      const caseNow = typeof c.case_now === "object" ? c.case_now.value : (c.case_now ?? golden.now);
      vi.stubEnv("RAILS_ENV", c.production ? "production" : "test");
      const handler = financeReportJobWith(jobFor(c.job), {
        redis: () => redis,
        now: () => new Date(Math.round(caseNow * 1000)),
      });

      let error: Error | null = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtimeOn(caseNow))), caseNow);
      } catch (e) {
        error = e as Error;
      }

      // Ruby accepts a Float period; Node hands it back before anything is pushed.
      if (c.args.some((arg) => arg instanceof RubyFloat)) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(await snapshotRedis(redis)).toEqual({});
        return;
      }
      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(withoutJobIds(plain(await snapshotRedis(redis)))).toEqual(withoutJobIds(plain(c.redis)));
    });
  }

  for (const c of golden.cases.filter((candidate) => candidate.hook)) {
    it(c.name, async () => {
      await redis.flushdb();
      const hook = financeReportRetriesExhaustedWith(jobFor(c.job), {
        now: () => new Date(Math.round(golden.now * 1000)),
      });
      const msg = { ...c.item, error_class: c.exception!.class, error_message: c.exception!.message } as unknown as SidekiqItem;

      await hook(msg, new Error(c.exception!.message), { runtime: runtimeOn(golden.now) });

      expect(withoutJobIds(plain(await snapshotRedis(redis)))).toEqual(withoutJobIds(plain(c.redis)));
    });
  }
});
