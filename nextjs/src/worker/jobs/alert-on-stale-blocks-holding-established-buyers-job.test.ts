// Replays alert-on-stale-blocks-holding-established-buyers-job.golden.json
// (scripts/golden/alert-on-stale-blocks-holding-established-buyers-job.rb): the job run by the real app as a Sidekiq job. Node reads the
// cursor the case started from (`redis_before`), sends the scans Rails sent and writes the cursor reset Rails wrote; a scan that finds a
// candidate block hands the job back whole, having written nothing.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden } from "./__fixtures__/replay-job-golden.ts";
import { scratchRedis } from "./__fixtures__/scratch-redis.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { alertOnStaleBlocksHoldingEstablishedBuyersJobWith } from "./alert-on-stale-blocks-holding-established-buyers-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/alert-on-stale-blocks-holding-established-buyers-job.golden.json", import.meta.url),
);
const now = () => new Date(Math.round(Number(golden.now) * 1000));

describe("AlertOnStaleBlocksHoldingEstablishedBuyersJob", () => {
  for (const c of golden.cases as (Omit<(typeof golden.cases)[number], "redis"> & {
    redis: Record<string, never>;
    redis_before?: Record<string, never>;
  })[]) {
    it(c.hands_back ? `hands back ${c.name} before any write` : c.name, async () => {
      const sql = sqlReplay(c.statements);
      const cursor = scratchRedis(c.redis_before);
      const sidekiq = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: sidekiq.redis,
        bullmqRedis: sidekiq.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const handler = alertOnStaleBlocksHoldingEstablishedBuyersJobWith({ now }, { redis: () => cursor.redis });
      const error = await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now).then(
        () => null,
        (e: unknown) => e as Error,
      );

      if (c.hands_back) {
        expect(error?.name).toBe("HandBackToRuby");
        // Only a read of the cursor: the reset is written after the second scan came back empty.
        expect(cursor.commands.filter((command) => command !== "get")).toEqual([]);
      } else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      if (!c.hands_back) expect(cursor.snapshot()).toEqual(c.redis);
      expect(sidekiq.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const sidekiq = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: sidekiq.redis,
      bullmqRedis: sidekiq.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = alertOnStaleBlocksHoldingEstablishedBuyersJobWith({ now }, { redis: () => scratchRedis({}).redis });
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
