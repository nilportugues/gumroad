// Replays cache-product-data-worker.golden.json (scripts/golden/cache-product-data-worker.rb): CacheProductDataWorker run by the real
// app as a Sidekiq job over a seeded database and a real Elasticsearch purchases index. Node sends the statements and the
// Elasticsearch requests Rails sent (cache expiry, the five metrics, the INSERT of the new ProductCachedValue), deletes the same
// cache key and fails the same way for a product that does not exist or a metric that raises. A closed tier on a tiered
// membership, a bundle Sku variant and an id that is not an Integer or its digits hand back.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { resetLinkCollaborators, setLinkCollaborators } from "../../server/models/link.ts";
import { setEsSender, type EsRequest } from "../../server/search/transport.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { cacheProductDataWorkerWith } from "./cache-product-data-worker.ts";

type Exchange = { method: string; path: string; body: string; status: number; response: unknown };
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  exchanges: Exchange[];
  cache: [string, string][];
};
const text = readFileSync(new URL("./__fixtures__/cache-product-data-worker.golden.json", import.meta.url), "utf8");
const golden = parseRubyJson(text) as unknown as { now: number; index: string; cases: Case[] };
// Elasticsearch answers reach the port as the plain JSON the transport parses; parseRubyJson keeps Ruby's Floats apart.
const answers = (JSON.parse(text) as { cases: { exchanges: Exchange[] }[] }).cases.map((c) => c.exchanges);
const handler = cacheProductDataWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) });

// Rails raises (RecordNotFound or a type error) for these; Node has no port of the id cast and hands the job back.
const ID_HAND_BACK = new Set([
  "a nil id",
  "an id that is not a number",
  "an id past a bigint",
  "an id given as a float",
]);
// Ruby creates the row; Node hands back once the metric reaches what it does not port.
const METRIC_HAND_BACK = new Set([
  "a tier closed to new purchases on a tiered membership",
  "a bundle variant that is a Sku",
]);

let restoreEs: (() => void) | undefined;
afterEach(() => {
  restoreEs?.();
  resetLinkCollaborators();
});

function runtime() {
  const recording = recordingSidekiqRedis();
  return {
    recording,
    runtime: createJobsRuntime({
      sidekiqRedis: recording.redis,
      bullmqRedis: recording.redis,
      registry: rubyRuntimeRegistry(),
      now: () => golden.now,
      newJid: sequentialJids(),
    }),
  };
}

describe("CacheProductDataWorker", () => {
  it("has golden cases for every metric edge and every id form", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(34);
  });

  for (const [index, c] of golden.cases.entries()) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const { recording, runtime: jobs } = runtime();
      const cache: [string, string][] = [];
      setLinkCollaborators({ cacheDelete: (name) => Promise.resolve(void cache.push(["cache_delete", name])) });
      const sent: EsRequest[] = [];
      const queue = [...answers[index]!];
      restoreEs = setEsSender(async (request) => {
        sent.push(request);
        const next = queue.shift();
        if (!next) throw new Error(`unexpected request ${request.method} ${request.path}`);
        return { status: next.status, body: next.response };
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(jobs)), golden.now);
      } catch (e) {
        error = e;
      }

      if (ID_HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        expect(sql.log).toEqual([]);
        expect(cache).toEqual([]);
      } else if (METRIC_HAND_BACK.has(c.name)) {
        expect((error as Error | null)?.name).toBe("HandBackToRuby");
        // The create transaction is rolled back; Ruby went on to INSERT the row.
        const sent = sql.log.filter((statement) => statement !== "ROLLBACK");
        expect(sent).toEqual(sql.expected.slice(0, sent.length));
        expect(sent.some((statement) => statement.startsWith("INSERT"))).toBe(false);
        expect(cache).toEqual(c.cache);
      } else {
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(sql.log).toEqual(sql.expected);
        expect(cache).toEqual(c.cache);
        expect(
          sent.map((request) => ({
            method: request.method,
            path: request.path.replace(/^\/purchases\//u, `/${golden.index}/`),
            body: request.body,
          })),
        ).toEqual(
          c.exchanges.map(({ method, path, body }) => ({ method, path: `/${path.replace(/^\//u, "")}`, body })),
        );
      }
      expect(recording.snapshot()).toEqual({});
    });
  }

  it("rejects a missing argument, as perform takes one", async () => {
    const sql = sqlReplay([]);
    const { runtime: jobs } = runtime();
    await expect(asSidekiqJob(() => handler([], contextFor(jobs)), golden.now)).rejects.toBeInstanceOf(Error);
    expect(sql.log).toEqual([]);
  });
});
