// Replays exports-sales-create-and-enqueue-chunks-worker.golden.json (scripts/golden/exports-sales-create-and-enqueue-chunks-worker.rb):
// the worker run by the real app as a Sidekiq job, with the first Elasticsearch call stood in for by a marker exception (nothing
// leaves the machine). Node sends the export read and the first read of the stale-chunk delete, finishes an export that does not exist
// with Rails' error, and hands back, before the first delete, an export that is found.
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
import { createAndEnqueueChunksWorkerWith } from "./exports-sales-create-and-enqueue-chunks-worker.ts";

const golden = loadGolden(
  new URL("./__fixtures__/exports-sales-create-and-enqueue-chunks-worker.golden.json", import.meta.url),
);

// Rails casts a String, a Float, nil and the rest in ways of its own: Node hands those back before any read.
const notAnInteger = (c: { args: unknown[] }) => typeof c.args[0] !== "number";

replayJobGolden(
  "Exports::Sales::CreateAndEnqueueChunksWorker",
  golden,
  createAndEnqueueChunksWorkerWith(),
  notAnInteger,
);

describe("Exports::Sales::CreateAndEnqueueChunksWorker stops before the first delete", () => {
  for (const c of golden.cases.filter((x) => x.hands_back && !notAnInteger(x))) {
    it(`reads the export and one chunk id for ${c.name}, and writes nothing`, async () => {
      const sql = sqlReplay(c.statements);
      const recording = recordingSidekiqRedis();
      const jobs = createJobsRuntime({
        sidekiqRedis: recording.redis,
        bullmqRedis: recording.redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const error = await asSidekiqJob(
        () => createAndEnqueueChunksWorkerWith()(c.args, contextFor(jobs)),
        golden.now,
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected.slice(0, 2));
      expect(sql.log.every((s) => s.startsWith("SELECT"))).toBe(true);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects no argument, as perform takes one", async () => {
    const sql = sqlReplay([]);
    const jobs = createJobsRuntime({
      sidekiqRedis: recordingSidekiqRedis().redis,
      bullmqRedis: recordingSidekiqRedis().redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(() => createAndEnqueueChunksWorkerWith()([], contextFor(jobs)), golden.now),
    ).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});
