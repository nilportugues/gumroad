// Replays sitemap-workers.golden.json (scripts/golden/sitemap-workers.rb): the daily, wishlist and monthly-categories sitemap workers
// run by the real app as Sidekiq jobs against the real generation lock. Node re-enqueues a run that finds the lock held exactly as
// Rails does (same class, arguments and delay), gives up on the last categories attempt, and hands back, before taking the lock, a
// run that would write the sitemap or whose arguments Ruby would fail on.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import {
  refreshSitemapDailyWorkerWith,
  refreshSitemapMonthlyWorkerWith,
  refreshWishlistSitemapDailyWorkerWith,
} from "./sitemap-workers.ts";

type Case = {
  name: string;
  job: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/sitemap-workers.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const LOCK = "sitemap_generation_lock";

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

function handlerFor(job: string, locked: boolean) {
  const sitemap = { redis: () => ({ get: () => Promise.resolve(locked ? "another-run" : null) }) };
  const now = () => new Date(Math.round(golden.now * 1000));
  if (job === "RefreshSitemapDailyWorker") return refreshSitemapDailyWorkerWith({ now }, sitemap);
  if (job === "RefreshWishlistSitemapDailyWorker") return refreshWishlistSitemapDailyWorkerWith(sitemap);
  return refreshSitemapMonthlyWorkerWith(sitemap);
}

// Rails fails on these inside the generation; Node hands them back untouched.
const HANDED_BACK_ON_ARGS = new Set(["a categories retry with the attempt as a string"]);

describe("sitemap workers", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const locked = c.redis_before?.[LOCK] !== undefined;
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handlerFor(c.job, locked)(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (c.hands_back || c.error !== null || HANDED_BACK_ON_ARGS.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(recording.snapshot()).toEqual({});
      } else {
        expect(error).toBeNull();
        // The lock itself is not Node's to write; the golden holds it as the case seeded it.
        const { [LOCK]: _lock, ...expected } = c.redis;
        expect(recording.snapshot()).toEqual(expected);
      }
    });
  }

  for (const [job, args] of [
    ["RefreshSitemapMonthlyWorker", []],
    ["RefreshSitemapMonthlyWorker", ["x"]],
    ["RefreshSitemapMonthlyWorker", [null, 1]],
    ["RefreshSitemapMonthlyWorker", ["categories_only", 1.5]],
  ] as [string, JsonValue[]][]) {
    it(`hands ${job} ${JSON.stringify(args)} back whatever the lock says`, async () => {
      for (const locked of [true, false]) {
        const { recording, runtime: jobs } = runtime();
        await expect(
          asSidekiqJob(() => handlerFor(job, locked)(args, contextFor(jobs)), golden.now),
        ).rejects.toMatchObject({ name: "HandBackToRuby" });
        expect(recording.snapshot()).toEqual({});
      }
    });
  }
});
