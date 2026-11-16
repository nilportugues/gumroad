// Replays backfill-orphaned-shown-products-in-profile-sections-job.golden.json
// (scripts/golden/backfill-orphaned-shown-products-in-profile-sections-job.rb): the job run by the real app as a Sidekiq job.
// Node sends the same statements: the section batches, the alive check outside and inside the seller's profile lock, and the
// validated update (or the rollback of a section that no longer validates, which is skipped). A shown_products entry that is not
// a plain integer hands the job back right after reading the section.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { backfillOrphanedShownProductsInProfileSectionsJobWith } from "./backfill-orphaned-shown-products-in-profile-sections-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
};
const golden = parseRubyJson(
  readFileSync(
    new URL("./__fixtures__/backfill-orphaned-shown-products-in-profile-sections-job.golden.json", import.meta.url),
    "utf8",
  ),
) as unknown as { now: number; cases: Case[] };
const handler = backfillOrphanedShownProductsInProfileSectionsJobWith({
  now: () => new Date(Math.round(golden.now * 1000)),
});

// Rails compares these ids as Ruby values after casting the ones it queries with; Node does not.
const HAND_BACK = new Set([
  "a section holding a string id",
  "a section holding a float id",
  "a section holding a null id",
  "a section holding an id past 2**53",
]);
// Cases whose cleanup Rails rescues, logging a warning.
const SKIPPED = new Map([
  ["a section left invalid by the cleanup", 1],
  ["a section left invalid by the cleanup and no profile row", 1],
  ["a section with a bad sort that cannot be saved", 1],
  ["a section with an extra key that cannot be saved", 1],
]);

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

let warnings: unknown[][] = [];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args));
});
afterEach(() => vi.restoreAllMocks());

describe("BackfillOrphanedShownProductsInProfileSectionsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, 1));
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
        expect(warnings).toHaveLength(SKIPPED.get(c.name) ?? 0);
      }
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
