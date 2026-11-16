// Replays requeue-transiently-failed-payouts-job.golden.json (scripts/golden/requeue-transiently-failed-payouts-job.rb): the job run by
// the real app as a Sidekiq job, each case on its own clock because the payout period follows the weekday. Node sends the one read Rails
// sent and finishes the runs where no payment failed transiently on the period; a run where one did (Rails went on to read its user)
// hands back after that read, before any write.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { requeueTransientlyFailedPayoutsJobWith } from "./requeue-transiently-failed-payouts-job.ts";

type Case = {
  name: string;
  now: number;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/requeue-transiently-failed-payouts-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Flipper rolls this one per call: the recorded run happened to roll one way, Node cannot know.
const COIN_FLIP = "nothing failed with the requeue disabled for half the time";
const goesOn = (c: Case) => c.statements.length > 1;

async function run(c: Case) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => c.now,
    newJid: sequentialJids(),
  });
  const before = c.redis_before ?? {};
  const sql = sqlReplay(c.statements);
  const handler = requeueTransientlyFailedPayoutsJobWith(
    { now: () => new Date(Math.round(c.now * 1000)) },
    { redis: () => ({ hgetall: (key) => Promise.resolve((before[key]?.value ?? {}) as Record<string, string>) }) },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), c.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RequeueTransientlyFailedPayoutsJob", () => {
  for (const c of golden.cases.filter((c) => !goesOn(c) && c.name !== COIN_FLIP)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter(goesOn)) {
    it(`hands ${c.name} back after the read`, async () => {
      const { error, sql, recording } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, 1));
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a disabling feature at a partial percentage of time back before the read", async () => {
    const { error, sql } = await run(golden.cases.find((c) => c.name === COIN_FLIP)!);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });

  it("rejects an extra argument, as perform takes none", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(() => requeueTransientlyFailedPayoutsJobWith()([1], contextFor(runtime)), golden.now),
    ).rejects.toBeInstanceOf(Error);
  });
});
