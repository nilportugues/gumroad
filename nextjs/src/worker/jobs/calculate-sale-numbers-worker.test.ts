// Replays calculate-sale-numbers-worker.golden.json (scripts/golden/calculate-sale-numbers-worker.rb): CalculateSaleNumbersWorker run
// by the real app as a Sidekiq job. Node sends the same purchase search and stores the same two Redis strings, fails with the same Ruby
// error on an answer without an aggregation, and hands back (before either key is written) the sums and cardinalities Ruby would
// read through a Float or a string.
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
import { calculateSaleNumbersWorkerWith } from "./calculate-sale-numbers-worker.ts";

type Case = {
  name: string;
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/calculate-sale-numbers-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; cases: Case[] };

// Ruby reads these through a Float (or `String#to_i`) that Node does not reproduce.
const HANDED_BACK = new Set(["a string sum"]);

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

async function run(c: Case) {
  const sql = sqlReplay(c.statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
  const fake = stringRedis();
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
  const handler = calculateSaleNumbersWorkerWith({}, { redis: () => fake.redis });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler([], contextFor(runtime)), golden.now);
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, fake, recording };
}

describe("CalculateSaleNumbersWorker", () => {
  for (const c of golden.cases.filter((c) => !HANDED_BACK.has(c.name))) {
    it(c.name, async () => {
      const { sql, es, error, fake, recording } = await run(c);

      expect(error === null ? null : error.message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(fake.snapshot()).toEqual(c.redis);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK.has(c.name))) {
    it(`hands ${c.name} back before any key is written`, async () => {
      const { es, error, fake } = await run(c);

      expect(error?.name).toBe("HandBackToRuby");
      expect(es.requests).toEqual(c.es);
      expect(fake.snapshot()).toEqual({});
    });
  }

  for (const [name, total] of [
    ["a sum past 2**53 as a float", 1e20],
    ["a sum Node cannot read as a number", { not: "a number" }],
  ] as const) {
    it(`hands ${name} back before any key is written`, async () => {
      const body: JsonValue = {
        aggregations: { total_made: { value: total as JsonValue }, number_of_creators: { value: 5 } },
      };
      const base = golden.cases[0];
      const { es, error, fake } = await run({ ...base, es_bodies: [body], statements: [] });

      expect(error?.name).toBe("HandBackToRuby");
      expect(es.requests).toHaveLength(1);
      expect(fake.snapshot()).toEqual({});
    });
  }

  it("rejects an argument, as perform takes none", async () => {
    const fake = stringRedis();
    const handler = calculateSaleNumbersWorkerWith({}, { redis: () => fake.redis });
    const runtime = createJobsRuntime({
      sidekiqRedis: recordingSidekiqRedis().redis,
      bullmqRedis: recordingSidekiqRedis().redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    });
    await expect(asSidekiqJob(() => handler([1], contextFor(runtime)), golden.now)).rejects.toThrow();
  });
});
