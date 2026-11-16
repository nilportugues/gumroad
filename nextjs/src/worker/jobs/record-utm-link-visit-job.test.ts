// Replays record-utm-link-visit-job.golden.json (scripts/golden/record-utm-link-visit-job.rb): the job run by the real app as a Sidekiq
// job. Node sends the seller, user and link lookups Rails sent and finishes a visit to a paused link or a seller that is gone; a visit
// Rails went on to record (the link create or the visit write) is handed back after the lookups, and a shape Node does not reproduce
// is handed back before any statement.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, replayJobGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { recordUtmLinkVisitJobWith } from "./record-utm-link-visit-job.ts";

const golden = loadGolden(new URL("./__fixtures__/record-utm-link-visit-job.golden.json", import.meta.url));

// Visits Rails ran on (or raised on) that Node does not reproduce: it hands them back before any statement.
const EARLY = new Set([
  "a visit with a parameter that is not a String",
  "a visit with an unknown parameter",
  "a visit with an unknown page type",
  "a visit with no page type",
  "a visit with no utm parameters at all",
  "a visit with no paper trail",
  "a visit with no visit time",
  "a visit with a visit time given as a String",
  "a visit with a visit time given as a Float",
]);

replayJobGolden("RecordUtmLinkVisitJob", golden, recordUtmLinkVisitJobWith(), (c: JobCase) => EARLY.has(c.name));

describe("RecordUtmLinkVisitJob arguments Node does not reproduce", () => {
  async function run(args: Parameters<ReturnType<typeof recordUtmLinkVisitJobWith>>[0]) {
    const sql = sqlReplay([]);
    const jobs = createJobsRuntime({
      sidekiqRedis: recordingSidekiqRedis().redis,
      bullmqRedis: recordingSidekiqRedis().redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = recordUtmLinkVisitJobWith();
    const error = await asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now).then(
      () => null,
      (e: unknown) => e as Error,
    );
    return { error, log: sql.log };
  }

  it("hands a visit that is not a Hash back before any statement", async () => {
    const { error, log } = await run(["not a hash"]);
    expect(error?.name).toBe("HandBackToRuby");
    expect(log).toEqual([]);
  });

  it("hands a seller id that is not an Integer back before any statement", async () => {
    const base = golden.cases.find((c) => c.name === "a visit to a link the seller paused")!.args[0] as Record<
      string,
      unknown
    >;
    const { error, log } = await run([{ ...base, seller_id: "abc" }]);
    expect(error?.name).toBe("HandBackToRuby");
    expect(log).toEqual([]);
  });

  it("rejects no argument and two arguments, as perform takes one", async () => {
    expect((await run([])).error).not.toBeNull();
    expect((await run([{}, {}])).error).not.toBeNull();
  });
});
