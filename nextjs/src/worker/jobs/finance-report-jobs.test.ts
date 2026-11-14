// Replays finance-report-jobs.golden.json (scripts/golden/finance-report-jobs.rb): the finance report jobs run by the real app as
// Sidekiq jobs and the block of their sidekiq_retries_exhausted. Node makes the `$redis` calls Rails made, in order, and pushes the
// failure mail Rails pushed. In production the job hands back before touching Redis.
import { readFileSync } from "node:fs";

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import { type JsonValue, RubyFloat, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import {
  FINANCE_REPORT_JOBS,
  type FinanceReportJob,
  financeReportJobWith,
  financeReportRetriesExhaustedWith,
} from "./finance-report-jobs.ts";

type Op = [string, ...JsonValue[]];
type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  hands_back?: boolean;
  hook?: boolean;
  item?: Record<string, JsonValue>;
  exception?: { class: string; message: string };
  redis: RedisSnapshot;
  redis_ops: Op[];
};

const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/finance-report-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as {
  now: number;
  cases: Case[];
};
const nowDate = () => new Date(Math.round(golden.now * 1000));
const sequentialUuid = () => {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
};
const withoutJobIds = (snapshot: RedisSnapshot) =>
  JSON.stringify(snapshot).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "JOB_ID");

// The `$redis` calls, as the generator logs them (numbers and strings alike compare as text).
function recordingRedis() {
  const ops: Op[] = [];
  const redis = {
    eval: (script: string, _count: number, key: string, ...argv: string[]) => {
      ops.push(["eval", script, [key], argv.map((value) => (/^\d+$/u.test(value) ? Number(value) : value))]);
      return Promise.resolve(1);
    },
    zrem: (key: string, member: string) => {
      ops.push(["zrem", key, member]);
      return Promise.resolve(1);
    },
    set: (key: string, value: string, ex: string, ttl: number) => {
      ops.push(["set", key, Number(value), { [ex.toLowerCase()]: ttl }]);
      return Promise.resolve("OK");
    },
  };
  return { redis: redis as unknown as Redis, ops };
}

const jobFor = (name: string): FinanceReportJob => FINANCE_REPORT_JOBS.find((job) => job.name === name)!;

beforeEach(() => {
  vi.stubEnv("RAILS_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("finance report jobs", () => {
  for (const c of golden.cases.filter((candidate) => !candidate.hook)) {
    it(c.name, async () => {
      const { redis, ops } = recordingRedis();
      const handler = financeReportJobWith(jobFor(c.job), {
        redis: () => redis,
        now: nowDate,
        uuid: sequentialUuid(),
        pid: () => 4242,
      });
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      // The generator's production cases are named for it. A wrong argument count in production is an ArgumentError in Rails and a
      // hand-back here, which Rails then answers the same way.
      const production = c.name.includes("in production");
      if (production) vi.stubEnv("RAILS_ENV", "production");

      let error: Error | null = null;
      try {
        await handler(c.args, contextFor(runtime));
      } catch (e) {
        error = e as Error;
      }

      if (production) {
        expect(error?.name).toBe("HandBackToRuby");
        expect(ops).toEqual([]);
      } else {
        expect(error?.message ?? null).toEqual(c.error?.message ?? null);
        expect(ops).toEqual(c.redis_ops);
      }
      expect(recording.snapshot()).toEqual({});
    });
  }
});

describe("finance report jobs, sidekiq_retries_exhausted", () => {
  for (const c of golden.cases.filter((candidate) => candidate.hook)) {
    it(c.name, async () => {
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const hook = financeReportRetriesExhaustedWith(jobFor(c.job), { now: nowDate });
      const msg = {
        ...c.item,
        error_class: c.exception!.class,
        error_message: c.exception!.message,
      } as unknown as SidekiqItem;

      await hook(msg, new Error(c.exception!.message), { runtime });

      expect(withoutJobIds(recording.snapshot())).toEqual(withoutJobIds(c.redis));
    });
  }

  it("fails, for the worker to log, on an argument whose Ruby inspection it does not reproduce", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const hook = financeReportRetriesExhaustedWith(jobFor("SendFinancesReportWorker"));
    const msg = {
      class: "SendFinancesReportWorker",
      args: [new RubyFloat(1.5)],
      error_class: "StandardError",
      error_message: "x",
    } as unknown as SidekiqItem;
    await expect(hook(msg, new Error("x"), { runtime })).rejects.toThrow();
    expect(recording.snapshot()).toEqual({});
  });
});

describe("finance report jobs without a golden", () => {
  it("hands back an argument whose Ruby to_s it does not reproduce, before the token is taken", async () => {
    const { redis, ops } = recordingRedis();
    const handler = financeReportJobWith(jobFor("SendFinancesReportWorker"), { redis: () => redis, now: nowDate });
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(handler([new RubyFloat(1.5)], contextFor(runtime))).rejects.toMatchObject({ name: "HandBackToRuby" });
    expect(ops).toEqual([]);
  });
});
