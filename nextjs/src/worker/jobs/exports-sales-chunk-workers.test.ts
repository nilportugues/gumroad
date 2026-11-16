// Replays exports-sales-compile-chunks-worker.golden.json and exports-sales-process-chunk-worker.golden.json (scripts/golden/exports-sales-*.rb):
// the two jobs run by the real app as Sidekiq jobs. Node sends the reads Rails sent, finishes a record that does not exist with Rails'
// error, and hands back, after the same reads, a record that is found.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { compileChunksWorkerWith, processChunkWorkerWith } from "./exports-sales-chunk-workers.ts";

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const oneArgumentCastByRails = (c: { args: unknown[] }) => c.args.length === 1 && castByRails(c.args[0]);

replayJobGolden(
  "Exports::Sales::CompileChunksWorker",
  loadGolden(new URL("./__fixtures__/exports-sales-compile-chunks-worker.golden.json", import.meta.url)),
  compileChunksWorkerWith(),
  oneArgumentCastByRails,
);
replayJobGolden(
  "Exports::Sales::ProcessChunkWorker",
  loadGolden(new URL("./__fixtures__/exports-sales-process-chunk-worker.golden.json", import.meta.url)),
  processChunkWorkerWith(),
  oneArgumentCastByRails,
);

// The replay above accepts a hand-back after any prefix of Rails' statements, so pin the chunk worker to the whole pair of reads.
describe("Exports::Sales::ProcessChunkWorker reads the chunk and then its export before handing back", () => {
  const golden = loadGolden(new URL("./__fixtures__/exports-sales-process-chunk-worker.golden.json", import.meta.url));
  for (const c of golden.cases.filter(
    (candidate) => candidate.hands_back && candidate.statements.length === 2 && !castByRails(candidate.args[0]),
  )) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const jobs = createJobsRuntime({
        sidekiqRedis: recordingSidekiqRedis().redis,
        bullmqRedis: recordingSidekiqRedis().redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      await expect(
        asSidekiqJob(() => processChunkWorkerWith()(c.args, contextFor(jobs)), golden.now),
      ).rejects.toMatchObject({ name: "HandBackToRuby" });
      expect(sql.log).toEqual(sql.expected);
    });
  }
});
