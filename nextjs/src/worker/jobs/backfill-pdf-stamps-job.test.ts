// Replays backfill-pdf-stamps-job.golden.json (scripts/golden/backfill-pdf-stamps-job.rb): BackfillPdfStampsJob run by the real app as a
// Sidekiq job, with the inline stamping replaced by a marker. Node sends the same reads, schedules the same next page and, where Rails
// reaches the stamping, hands back after those reads with nothing pushed.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { backfillPdfStampsJobWith } from "./backfill-pdf-stamps-job.ts";

const golden = loadGolden(new URL("./__fixtures__/backfill-pdf-stamps-job.golden.json", import.meta.url));

replayJobGolden("BackfillPdfStampsJob", golden, backfillPdfStampsJobWith());

describe("BackfillPdfStampsJob arguments Node does not reproduce", () => {
  it.each([
    ["a product id that is a word", ["abc"]],
    ["a product id that is a float", [1.5]],
    ["a product id that is nil", [null]],
    ["a purchase id that is a word", [1, "abc"]],
    ["a purchase id that is a float", [1, 2.5]],
  ])("hands %s back before any statement", async (_name, args) => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const sql = sqlReplay([]);
    let error: unknown = null;
    try {
      await asSidekiqJob(() => backfillPdfStampsJobWith()(args as JsonValue[], contextFor(runtime)), golden.now);
    } catch (e) {
      error = e;
    }

    expect((error as Error).name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
    expect(recording.snapshot()).toEqual({});
  });
});
