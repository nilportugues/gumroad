// Replays backfill-taggings-count-on-tags-job.golden.json (scripts/golden/backfill-taggings-count-on-tags-job.rb):
// BackfillTaggingsCountOnTagsJob run by the real app as a Sidekiq job. Node sends the same statements (batch selects, the row
// lock, the grouped count, one UPDATE per resulting count), checks replica lag once per batch and prints the same progress lines.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
import { backfillTaggingsCountOnTagsJobWith } from "./backfill-taggings-count-on-tags-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  replica_lag_watches: number;
  output: string;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/backfill-taggings-count-on-tags-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

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

describe("BackfillTaggingsCountOnTagsJob", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let watches = 0;
      const written: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      try {
        const handler = backfillTaggingsCountOnTagsJobWith({
          watchReplicaLag: () => {
            watches += 1;
            return Promise.resolve();
          },
        });
        await asSidekiqJob(() => handler([], contextFor(jobs)), golden.now);
      } finally {
        stdout.mockRestore();
      }

      expect(sql.log).toEqual(sql.expected);
      expect(watches).toBe(c.replica_lag_watches);
      expect(written.join("")).toBe(c.output);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    const handler = backfillTaggingsCountOnTagsJobWith();
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
