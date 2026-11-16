// Replays million-dollar-milestone-check-worker.golden.json (scripts/golden/million-dollar-milestone-check-worker.rb): the job run by the real
// app as a Sidekiq job, Elasticsearch answered with the sums each case sets. Node reads the same seller batches and sends the same purchase
// searches; the first seller at or over $1M, and a sum that is not a number (where Ruby fails on nil), are handed back with everything read
// so far matching, nothing written.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { esRecorder } from "../../server/search/__fixtures__/job-harness.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
  type RedisSnapshot,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { millionDollarMilestoneCheckWorkerWith } from "./million-dollar-milestone-check-worker.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/million-dollar-milestone-check-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };
const NOW = golden.now;

// Rails announced the seller (GoldenReached), or failed on a nil sum: Node hands both back.
const handedBack = (c: Case) => c.error !== null;

async function run(c: Case) {
  const sql = sqlReplay(c.statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  const handler = millionDollarMilestoneCheckWorkerWith({ now: () => new Date(Math.round(NOW * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), NOW);
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, recording };
}

describe("MillionDollarMilestoneCheckWorker", () => {
  for (const c of golden.cases.filter((c) => !handedBack(c))) {
    it(c.name, async () => {
      const { sql, es, error, recording } = await run(c);

      expect(error).toBeNull();
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const c of golden.cases.filter(handedBack)) {
    it(`hands ${c.name} back after reading`, async () => {
      const { sql, es, error, recording } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const handler = millionDollarMilestoneCheckWorkerWith();
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => NOW,
      newJid: sequentialJids(),
    });
    await expect(handler([1], contextFor(runtime))).rejects.toThrow(/wrong number of arguments/u);
  });
});
