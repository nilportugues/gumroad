// Replays calculate-payout-numbers-worker.golden.json (scripts/golden/calculate-payout-numbers-worker.rb): CalculatePayoutNumbersWorker
// run by the real app as a Sidekiq job. Node searches the same Monday-to-Sunday week in Los Angeles (daylight saving changes, year
// ends and the Sunday-night/Monday boundary included), stores the same whole-dollar string and fails with the same Ruby error on an
// answer without a number to divide. A Float sum Ruby cannot carry exactly hands back before the key is written.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
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
import { calculatePayoutNumbersWorkerWith } from "./calculate-payout-numbers-worker.ts";

type Case = {
  name: string;
  now: number | RubyFloat;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/calculate-payout-numbers-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };

function stringRedis() {
  const strings = new Map<string, string>();
  return {
    redis: {
      // A TTL or option argument would expire the key; Rails sets none.
      set: (key: string, value: string, ...options: unknown[]) => {
        if (options.length > 0) throw new Error("SET with options");
        strings.set(key, value);
        return Promise.resolve("OK" as const);
      },
    },
    snapshot: () =>
      Object.fromEntries([...strings].map(([key, value]) => [key, { type: "string", value, expires: false }])),
  };
}

// A whole-second clock arrives as a Ruby Float.
const seconds = (c: Case) => (c.now instanceof RubyFloat ? c.now.value : c.now);

async function run(c: Case) {
  const sql = sqlReplay(c.statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
  const fake = stringRedis();
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => seconds(c),
    newJid: sequentialJids(),
  });
  const handler = calculatePayoutNumbersWorkerWith(
    { now: () => new Date(Math.round(seconds(c) * 1000)) },
    { redis: () => fake.redis },
  );
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), seconds(c));
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, fake, recording };
}

describe("CalculatePayoutNumbersWorker", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const { sql, es, error, fake, recording } = await run(c);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(fake.snapshot()).toEqual(c.redis);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const [name, total] of [
    ["a Float sum past 2**53", 1e20],
    ["a sum of a type the golden does not cover", { not: "a number" }],
  ] as const) {
    it(`hands ${name} back before the key is written`, async () => {
      const base = golden.cases[0]!;
      const body: JsonValue = { aggregations: { total_made: { value: total as JsonValue } } };
      const { es, error, fake } = await run({ ...base, es_bodies: [body], statements: [] });

      expect(error?.name).toBe("HandBackToRuby");
      expect(es.requests).toHaveLength(1);
      expect(fake.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const base = golden.cases[0]!;
    const fake = stringRedis();
    const handler = calculatePayoutNumbersWorkerWith({}, { redis: () => fake.redis });
    const recording = recordingSidekiqRedis();
    const runtime = createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => seconds(base),
      newJid: sequentialJids(),
    });
    await expect(asSidekiqJob(() => handler([1], contextFor(runtime)), seconds(base))).rejects.toThrow();
  });
});
