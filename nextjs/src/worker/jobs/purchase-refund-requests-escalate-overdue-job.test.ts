// Replays purchase-refund-requests-escalate-overdue-job.golden.json (scripts/golden/purchase-refund-requests-escalate-overdue-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the scan and its preloads Rails sent, skips the requests Rails skipped and,
// at the first one Rails went on to `escalate!`, hands the job back whole before any write.
import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { loadGolden, type JobCase } from "./__fixtures__/replay-job-golden.ts";
import { sqlReplay } from "./__fixtures__/sql-replay.ts";
import {
  escalationDeadlineEnd,
  purchaseRefundRequestsEscalateOverdueJobWith,
} from "./purchase-refund-requests-escalate-overdue-job.ts";

type Case = JobCase & { now: number; escalated: number[]; redis_before?: Record<string, { value?: unknown }> };
const golden = loadGolden(
  new URL("./__fixtures__/purchase-refund-requests-escalate-overdue-job.golden.json", import.meta.url),
) as unknown as { now: number; cases: Case[] };

// Whole seconds parse as a RubyFloat.
const seconds = (c: Case) =>
  (c.now as unknown as RubyFloat | number) instanceof RubyFloat ? (c.now as unknown as RubyFloat).value : c.now;

async function run(c: Case, flag: Record<string, string> | undefined = undefined) {
  const recording = recordingSidekiqRedis();
  const jobs = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => seconds(c),
    newJid: sequentialJids(),
  });
  const doc = flag ?? ((c.redis_before?.buyer_refund_requests?.value ?? {}) as Record<string, string>);
  const sql = sqlReplay(c.statements);
  const handler = purchaseRefundRequestsEscalateOverdueJobWith(
    { now: () => new Date(Math.round(seconds(c) * 1000)) },
    { redis: () => ({ hgetall: () => Promise.resolve(doc) }) },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(jobs)), seconds(c));
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

// Flipper rolls a percentage of time per call: the recorded run happened to roll open, Node cannot know.
const ROLLS = "a request that is due and the feature is on for 50 percent of time";

describe("PurchaseRefundRequests::EscalateOverdueJob", () => {
  for (const c of golden.cases.filter((x) => x.name !== ROLLS)) {
    it(c.hands_back ? `hands back ${c.name} before any write` : c.name, async () => {
      const { error, sql, recording } = await run(c);

      if (c.hands_back) expect(error?.name).toBe("HandBackToRuby");
      else expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a due request back when the feature rolls per call, whichever way Rails rolled", async () => {
    const c = golden.cases.find((x) => x.name === ROLLS)!;
    const { error, sql } = await run(c);
    expect(error?.message).toContain("percentage of time");
    expect(sql.log).toEqual(sql.expected);
  });

  it("finishes without a hand-back when the feature is off for every request", async () => {
    const c = golden.cases.find((x) => x.name === "two requests that are due, the feature off")!;
    const { error, sql } = await run(c);
    expect(error).toBeNull();
    expect(sql.log).toEqual(sql.expected);
  });

  it("hands back a feature behind an expression gate", async () => {
    const c = golden.cases.find((x) => x.name === "a request that is due")!;
    const { error } = await run(c, { expression: JSON.stringify({ Property: ["plan"] }) });
    expect(error?.name).toBe("HandBackToRuby");
    expect(error?.message).toContain("expression gate");
  });

  it("rejects an argument, as perform takes none", async () => {
    const sql = sqlReplay([]);
    const recording = recordingSidekiqRedis();
    const jobs = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    const handler = purchaseRefundRequestsEscalateOverdueJobWith();
    await expect(asSidekiqJob(() => handler([1], contextFor(jobs)), golden.now)).rejects.toThrow();
    expect(sql.log).toEqual([]);
  });
});

describe("escalationDeadlineEnd", () => {
  const at = (iso: string) => escalationDeadlineEnd(new Date(iso)).toISOString();

  it("counts two weekdays from a Monday", () => {
    expect(at("2026-11-02T12:00:00Z")).toBe("2026-11-05T00:00:00.000Z");
  });

  it("skips the weekend from a Friday", () => {
    expect(at("2026-10-30T12:00:00Z")).toBe("2026-11-04T00:00:00.000Z");
  });

  it("starts a Saturday and a Sunday request on the following Monday", () => {
    expect(at("2026-10-31T12:00:00Z")).toBe("2026-11-04T00:00:00.000Z");
    expect(at("2026-11-01T12:00:00Z")).toBe("2026-11-04T00:00:00.000Z");
  });
});
