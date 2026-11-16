// Replays mcp-deliver-event-job.golden.json (scripts/golden/mcp-deliver-event-job.rb): the job run by the real app as a Sidekiq job,
// with the outbound POST stood in for by a marker exception (nothing is sent). Node sends the live lookup, finishes a subscription that
// is gone or whose connection holds no token (the delete), hands back whole, before any write, a connection that holds a token, and
// hands back before any statement an event or attempt whose shape the log line would trip on in Ruby.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import { mcpDeliverEventJobWith } from "./mcp-deliver-event-job.ts";

const golden = loadGolden(new URL("./__fixtures__/mcp-deliver-event-job.golden.json", import.meta.url));
const now = () => new Date(Math.round(Number(golden.now) * 1000));

const EARLY = new Set([
  "a nil event",
  "a nil event and no token",
  "an event given as a String and no token",
  "an event given as an Array and no token",
  "an attempt given as a String and no token",
  "a nil attempt and no token",
  "an attempt given as a Float and no token",
]);
const holdsToken = (c: JobCase) => (c.statements[1]?.result?.rows?.length ?? 0) > 0;

async function run(c: JobCase) {
  const sql = sqlReplay(c.statements);
  const recording = recordingSidekiqRedis();
  const jobs = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = mcpDeliverEventJobWith({ now });
  const error = await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now).then(
    () => null,
    (e: unknown) => e as Error,
  );
  return { error, sql, recording };
}

describe("Mcp::DeliverEventJob", () => {
  for (const c of golden.cases) {
    if (EARLY.has(c.name)) {
      it(`hands ${c.name} back before any statement`, async () => {
        const { error, sql, recording } = await run(c);
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
        expect(recording.snapshot()).toEqual({});
      });
    } else if (holdsToken(c)) {
      it(`hands ${c.name} back after the token lookup, before any write`, async () => {
        const { error, sql, recording } = await run(c);
        expect(error?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual(sql.expected.slice(0, 2));
        expect(sql.log.some((s) => s.startsWith("DELETE"))).toBe(false);
        expect(recording.snapshot()).toEqual({});
      });
    } else {
      it(c.name, async () => {
        const { error, sql, recording } = await run(c);
        expect(error).toBeNull();
        expect(sql.log).toEqual(sql.expected);
        expect(recording.snapshot()).toEqual({});
      });
    }
  }

  it("hands a subscription id that is not an Integer back before any statement", async () => {
    const base = golden.cases.find((c) => c.name === "a subscription that does not exist")!;
    const { error, sql } = await run({ ...base, args: ["abc", { name: "sale.created" }] });
    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual([]);
  });

  it("rejects one argument and four, as perform takes two or three", async () => {
    for (const args of [[1], [1, {}, 0, 5]]) {
      const sql = sqlReplay([]);
      const jobs = createJobsRuntime({
        sidekiqRedis: recordingSidekiqRedis().redis,
        bullmqRedis: recordingSidekiqRedis().redis,
        registry: rubyRuntimeRegistry(),
        now: () => golden.now,
        newJid: sequentialJids(),
      });
      const handler = mcpDeliverEventJobWith({ now });
      await expect(asSidekiqJob(() => handler(args, contextFor(jobs)), golden.now)).rejects.toThrow();
      expect(sql.log).toEqual([]);
    }
  });
});
