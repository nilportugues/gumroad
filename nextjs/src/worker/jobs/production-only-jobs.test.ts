// Replays production-only-jobs.golden.json (scripts/golden/production-only-jobs.rb): the two jobs run by the real app as Sidekiq jobs.
// Outside production Rails returns and touches nothing, and a wrong argument count is an ArgumentError; Node does the same. In
// production the run is handed back before anything is read or written, which Rails then answers (the recorded run reaches its first
// read, or raises the same ArgumentError).
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { type JsonValue, parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import { contextFor, recordingSidekiqRedis, rubyRuntimeRegistry, sequentialJids, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sendStripeBalanceCheckNotificationJob, verifyFinanceReportsDeliveryJob } from "./production-only-jobs.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: unknown[];
  redis: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/production-only-jobs.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

const handlers = {
  SendStripeBalanceCheckNotificationJob: sendStripeBalanceCheckNotificationJob,
  VerifyFinanceReportsDeliveryJob: verifyFinanceReportsDeliveryJob,
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function run(c: Case, env: string) {
  vi.stubEnv("RAILS_ENV", env);
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await handlers[c.job as keyof typeof handlers](c.args, contextFor(runtime));
  } catch (e) {
    error = e as Error;
  }
  return { error, recording };
}

describe("production-only jobs", () => {
  for (const c of golden.cases.filter((c) => !c.name.includes("in production"))) {
    it(c.name, async () => {
      const { error, recording } = await run(c, "test");

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(c.statements).toEqual([]);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const c of golden.cases.filter((c) => c.name.includes("in production"))) {
    it(`hands ${c.name} back before any read or write`, async () => {
      const { error, recording } = await run(c, "production");

      expect(error?.name).toBe("HandBackToRuby");
      expect(c.statements).toEqual([]);
      expect(c.hands_back || c.error !== null).toBe(true);
      expect(recording.snapshot()).toEqual({});
    });
  }
});
