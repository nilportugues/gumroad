// Replays payout-batch-fan-out.golden.json (scripts/golden/payout-batch-fan-out.rb): the two weekly payout batch jobs run by the real
// app as Sidekiq jobs. Node pushes the same per-type jobs (lock digests included) and returns for the same blank seller lists; every
// other shape hands the job back before a statement or a Redis write.
//
// The push cases need JOBS_REDIS_URL (a scratch database other than 0) because the unique-jobs lock is a Lua script; they are skipped without it.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  rubyRuntimeRegistry,
  sequentialJids,
  snapshotRedis,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import {
  performPayoutsForUserSliceWorker,
  performPayoutsForUserSliceWorkerRetriesExhausted,
  performPayoutsUpToDelayDaysAgoWorker,
  performPayoutsUpToDelayDaysAgoWorkerRetriesExhausted,
} from "./payout-batch-jobs.ts";
import type { JobHandler } from "./types.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  at: number;
  error: { class: string; message: string } | null;
  statements: unknown[];
  redis: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/payout-batch-fan-out.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };
const HANDLERS: Record<string, JobHandler> = {
  PerformPayoutsUpToDelayDaysAgoWorker: performPayoutsUpToDelayDaysAgoWorker,
  PerformPayoutsForUserSliceWorker: performPayoutsForUserSliceWorker,
};

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
beforeEach(async () => {
  await redis?.flushdb();
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});

async function run(job: string, args: JsonValue[], at: number): Promise<Error | null> {
  const runtime = createJobsRuntime({
    sidekiqRedis: redis!,
    bullmqRedis: redis!,
    registry: rubyRuntimeRegistry(),
    now: () => at,
    newJid: sequentialJids(),
  });
  try {
    await asSidekiqJob(() => HANDLERS[job]!(args, contextFor(runtime)), at);
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("payout batch jobs", () => {
  for (const c of golden.cases) {
    it.skipIf(!url)(c.name, async () => {
      const error = await run(c.job, c.args, c.at);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(await snapshotRedis(redis!)).toEqual(c.redis);
    });
  }

  for (const [name, args] of [
    ["one bank account type", ["STRIPE", ["UkBankAccount"]]],
    ["no bank account types", ["STRIPE"]],
    ["bank account types that are nil", ["STRIPE", null]],
    ["a bank account type that is a string", ["STRIPE", "UkBankAccount"]],
    ["an empty list of bank account types", ["STRIPE", []]],
  ] as [string, JsonValue[]][]) {
    it.skipIf(!url)(`hands ${name} of the orchestrator back before any write`, async () => {
      const error = await run("PerformPayoutsUpToDelayDaysAgoWorker", args, 1_793_795_445);

      expect(error?.name).toBe("HandBackToRuby");
      expect(await snapshotRedis(redis!)).toEqual({});
    });
  }

  for (const [name, args] of [
    ["seller ids", ["STRIPE", "2026-10-30", [7, 8]]],
    ["seller ids with a bank account type", ["STRIPE", "2026-10-30", [7], "UkBankAccount"]],
    ["a zero for seller ids", ["STRIPE", "2026-10-30", 0]],
    ["a string of seller ids", ["STRIPE", "2026-10-30", "7"]],
    ["a non-breaking space for seller ids", ["STRIPE", "2026-10-30", " "]],
    ["a hash of seller ids", ["STRIPE", "2026-10-30", { a: 1 }]],
  ] as [string, JsonValue[]][]) {
    it.skipIf(!url)(`hands ${name} of the slice back before any write`, async () => {
      const error = await run("PerformPayoutsForUserSliceWorker", args, 1_793_795_445);

      expect(error?.name).toBe("HandBackToRuby");
      expect(await snapshotRedis(redis!)).toEqual({});
    });
  }

  it.skipIf(!url)("rejects the wrong number of arguments, as perform takes", async () => {
    expect((await run("PerformPayoutsUpToDelayDaysAgoWorker", [], 1))?.message).toMatch(/given 0, expected 1\.\.2/u);
    expect((await run("PerformPayoutsUpToDelayDaysAgoWorker", ["STRIPE", [], []], 1))?.message).toMatch(
      /given 3, expected 1\.\.2/u,
    );
    expect((await run("PerformPayoutsForUserSliceWorker", ["STRIPE", "2026-10-30"], 1))?.message).toMatch(
      /given 2, expected 3\.\.4/u,
    );
    expect((await run("PerformPayoutsForUserSliceWorker", ["STRIPE", "d", [], "a", "b"], 1))?.message).toMatch(
      /given 5, expected 3\.\.4/u,
    );
  });

  it("hands both jobs back once their retries are exhausted, so Ruby mails the failure", async () => {
    for (const hook of [
      performPayoutsUpToDelayDaysAgoWorkerRetriesExhausted,
      performPayoutsForUserSliceWorkerRetriesExhausted,
    ]) {
      await expect(hook({} as never, new Error("boom"), {} as never)).rejects.toMatchObject({ name: "HandBackToRuby" });
    }
  });
});
