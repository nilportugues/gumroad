// Replays alert-on-stuck-piracy-reports-job.golden.json (scripts/golden/alert-on-stuck-piracy-reports-job.rb): the job run by the real
// app as a Sidekiq job. Node sends the six reads Rails sent and finishes the runs where nothing waits for a person; a run Rails went on
// to alert about (an InternalNotificationWorker in its queue) hands back after the reads, before any write.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { alertOnStuckPiracyReportsJobWith } from "./alert-on-stuck-piracy-reports-job.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  redis_before?: RedisSnapshot;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/alert-on-stuck-piracy-reports-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Flipper rolls this one per call: the recorded run happened to roll "off", Node cannot know.
const COIN_FLIP = "nothing to report with sending at 50 percent of time";
const alerts = (c: Case) => "queue:default" in c.redis;

async function run(c: Case) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const before = c.redis_before ?? {};
  const sql = sqlReplay(c.statements);
  const handler = alertOnStuckPiracyReportsJobWith(
    { now: () => new Date(Math.round(golden.now * 1000)) },
    { redis: () => ({ hgetall: (key) => Promise.resolve((before[key]?.value ?? {}) as Record<string, string>) }) },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, recording };
}

describe("AlertOnStuckPiracyReportsJob", () => {
  for (const c of golden.cases.filter((c) => !alerts(c) && c.name !== COIN_FLIP)) {
    it(c.name, async () => {
      const { error, sql, recording } = await run(c);

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => alerts(c))) {
    it(`hands ${c.name} back after the reads`, async () => {
      const { error, sql, recording } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("hands a sending feature at a partial percentage of time back after the reads", async () => {
    const { error, sql } = await run(golden.cases.find((c) => c.name === COIN_FLIP)!);

    expect(error?.name).toBe("HandBackToRuby");
    expect(sql.log).toEqual(sql.expected.slice(0, 3));
  });

  it("rejects an extra argument, as perform takes none", async () => {
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(
      asSidekiqJob(() => alertOnStuckPiracyReportsJobWith()([1], contextFor(runtime)), golden.now),
    ).rejects.toBeInstanceOf(Error);
  });
});
