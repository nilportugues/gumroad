// Replays retry-failed-paypal-payouts-worker.golden.json (scripts/golden/retry-failed-paypal-payouts-worker.rb): the worker run by the
// real app as a Sidekiq job on each weekday the end date depends on, with the switch read from `redis_before`. Node sends the one
// read Rails sent (none while the switch is on) and finishes the runs that find no seller; a run that finds one hands back after the
// read with nothing pushed. A switch on a percentage of time is rolled per call by Flipper, so it hands back before any read.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { loadGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { retryFailedPaypalPayoutsWorkerWith } from "./retry-failed-paypal-payouts-worker.ts";

type Case = JobCase & { redis_before: RedisSnapshot };
const golden = loadGolden(
  new URL("./__fixtures__/retry-failed-paypal-payouts-worker.golden.json", import.meta.url),
) as unknown as {
  now: number;
  cases: Case[];
};

const COIN_FLIP = "the requeue at 50 percent of time";
// The scripts ran each case at its own date; the weekday cases carry it in their name.
const DAY_OF_CASE: Record<string, string> = {
  Sunday: "2026-11-01",
  Monday: "2026-11-02",
  Tuesday: "2026-11-03",
  Friday: "2026-11-06",
  Saturday: "2026-11-07",
};
const clockOf = (name: string) => {
  const day = Object.keys(DAY_OF_CASE).find((weekday) => name.endsWith(` ${weekday}`));
  return day === undefined ? new Date(Math.round(golden.now * 1000)) : new Date(`${DAY_OF_CASE[day]}T12:30:45.123Z`);
};

async function run(c: Case) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(c.statements);
  const handler = retryFailedPaypalPayoutsWorkerWith({
    redis: () => ({ hgetall: (key) => Promise.resolve((c.redis_before[key]?.value ?? {}) as Record<string, string>) }),
  })({ now: () => clockOf(c.name) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("RetryFailedPaypalPayoutsWorker", () => {
  for (const c of golden.cases.filter((c) => c.name !== COIN_FLIP)) {
    it(c.hands_back ? `hands ${c.name} back after the read` : c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(error?.name ?? null).toBe(c.hands_back ? "HandBackToRuby" : null);
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a switch at a partial percentage of time back before any read", async () => {
    const { error, sql } = await run(golden.cases.find((c) => c.name === COIN_FLIP)!);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });

  it("rejects an extra argument, as perform takes none", async () => {
    const { error } = await (async () => {
      const recording = recordingSidekiqRedis();
      const runtime = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      try {
        await asSidekiqJob(() => retryFailedPaypalPayoutsWorkerWith()()([1], contextFor(runtime)), golden.now);
        return { error: null };
      } catch (e) {
        return { error: e as Error };
      }
    })();

    expect(error).toBeInstanceOf(Error);
  });
});
