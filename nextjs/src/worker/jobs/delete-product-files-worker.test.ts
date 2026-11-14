// Replays delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb): DeleteProductFilesWorker run by the
// real app as a Sidekiq job over a recorded Elasticsearch socket. Node sends the statements, cache deletes, Sidekiq pushes and
// Elasticsearch requests Rails did for every case it finished, and fails with the same Ruby error where Rails raised (a missing
// product, an unreadable search answer, a file that does not validate), including the classifier that rewrites a product's inferred
// taxonomy values after each file; an id Rails casts (a float, a word) hands back before any statement.
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { rubyTimeToF } from "../../server/models/concerns/ruby-time.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";
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
import { deleteProductFilesWorkerWith } from "./delete-product-files-worker.ts";

type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  redis: RedisSnapshot;
  cache: [string, string][];
  es: { method: string; path: string; query: string | null; body: string | null }[];
  es_bodies: JsonValue[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/delete-product-files-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { cases: Case[] };
const NOW_DATE = new Date(Date.UTC(2026, 10, 4, 12, 30, 45, 123));
// Time#to_f, which Sidekiq stamps the pushed job with.
const NOW = rubyTimeToF(NOW_DATE);

// Rails casts these ids; Node hands them back.
const CAST_IDS = new Set(["a product id given as a float", "a product id given as a word"]);
// A bare `total` is a number where Elasticsearch answers an object: Node hands it back after the search.
const BARE_TOTAL = "a search answer with a bare total";
// An array or an object is a Hashie wrapper in Ruby, whose errors Node does not reproduce.
const WRAPPED_TOTAL = /with an (array|object) as the total value/u;

// The test environment's S3_BASE_URL (config/initializers/aws.rb), which the seeded urls are built from.
beforeAll(() => {
  vi.stubEnv("S3_BASE_URL_TEMPLATE", "http://localhost:9000/gumroad-specs/");
});
afterEach(resetLinkCollaborators);

async function run(c: Case, statements: Statement[]) {
  const sql = sqlReplay(statements);
  const es = esRecorder(c.es_bodies.map((body): [number, JsonValue] => [200, body]));
  const recording = recordingSidekiqRedis();
  const cache: [string, string][] = [];
  setLinkCollaborators({
    cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])),
    isFeatureEnabled: () => Promise.resolve(false),
  });
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => NOW,
    newJid: sequentialJids(),
  });
  let error: Error | null = null;
  try {
    await asSidekiqJob(
      () => deleteProductFilesWorkerWith({ now: () => new Date(NOW_DATE) })(c.args, contextFor(runtime)),
      NOW,
    );
  } catch (e) {
    error = e as Error;
  } finally {
    es.restore();
  }
  return { sql, es, error, recording, cache };
}

describe("DeleteProductFilesWorker", () => {
  for (const c of golden.cases.filter(
    (c) => !CAST_IDS.has(c.name) && c.name !== BARE_TOTAL && !WRAPPED_TOTAL.test(c.name),
  )) {
    it(c.name, async () => {
      const { sql, es, error, recording, cache } = await run(c, c.statements);

      expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(error?.name ?? null).toEqual(c.error ? c.error.class.split("::").pop() : null);
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
      expect(cache).toEqual(c.cache);
      expect(recording.snapshot()).toEqual(c.redis);
    });
  }

  for (const c of golden.cases.filter((c) => c.name === BARE_TOTAL || WRAPPED_TOTAL.test(c.name))) {
    it(`hands ${c.name} back after the search`, async () => {
      const { sql, es, error } = await run(c, c.statements);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(es.requests).toEqual(c.es);
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { sql, es, error } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
      expect(es.requests).toEqual([]);
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const { sql, error } = await run({ ...golden.cases[0]!, args: [] }, []);

    expect(error).not.toBeNull();
    expect(sql.log).toEqual([]);
  });
});
