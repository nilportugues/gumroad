// Replays delete-product-files-archives-worker.golden.json (scripts/golden/delete-product-files-archives-worker.rb): DeleteProductFilesArchivesWorker run by
// the real app as a Sidekiq job. Node sends the statements Rails sent up to the point it decides on, fails with the same error, and
// for a live archive to delete hands the job back before it writes anything.
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
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { deleteProductFilesArchivesWorkerWith } from "./delete-product-files-archives-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  hands_back: boolean;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/delete-product-files-archives-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const handler = deleteProductFilesArchivesWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

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

describe("DeleteProductFilesArchivesWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (c.hands_back) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log.some((statement) => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      }
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const args of [["abc"], [1.5], [[1]], [1, ""], [null, "x"], [null, 0.5], [1, 1.5]] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const { runtime: jobs } = runtime();
      await expect(asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now)).rejects.toMatchObject({
        name: "HandBackToRuby",
      });
      expect(sql.log).toEqual([]);
    });
  }
});
