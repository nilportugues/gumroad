// Replays regenerate-creator-analytics-cache-worker.golden.json (scripts/golden/regenerate-creator-analytics-cache-worker.rb):
// the job run by the real app as a Sidekiq job, Elasticsearch answered by a canned socket that recorded every request. Production Sidekiq
// caps both the writing and the reading connection, so the golden carries each `max_execution_time` statement twice; Node has one pool
// and one cap (proven in server/models/runtime/max-execution-time.golden.test.ts), so the cap statements are checked on their own and
// left out of the comparison of the rest. Compared per case: the statements (including each cached day's JSON), the Elasticsearch
// requests, and the analytics cache version key of the main Redis.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, RubyFloat, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { setPinnedSessionFactory } from "../../server/models/runtime/max-execution-time.ts";
import { setEsSender } from "../../server/search/transport.ts";
import type { SqlClient } from "../../server/models/sql.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { regenerateCreatorAnalyticsCacheWorkerWith } from "./regenerate-creator-analytics-cache-worker.ts";

const VERSION_KEY = "seller_analytics:cache_version";
const mainRedis = vi.hoisted(() => ({ value: null as string | null, reads: [] as string[] }));
vi.mock("../../server/infra/redis.ts", async (original) => ({
  ...(await original<typeof import("../../server/infra/redis.ts")>()),
  getRedis: () => ({
    get: async (key: string) => {
      mainRedis.reads.push(key);
      return mainRedis.value;
    },
  }),
}));

// sqlReplay installs its client with setSqlClient; the block's connection delegates to it.
const replay = vi.hoisted(() => ({ client: null as null | (() => unknown) }));
vi.mock("../../server/models/sql.ts", async (original) => {
  const module = await original<typeof import("../../server/models/sql.ts")>();
  return {
    ...module,
    setSqlClient: (next: Parameters<typeof module.setSqlClient>[0]) => {
      replay.client = next as () => unknown;
      module.setSqlClient(next);
    },
  };
});

type Es = { method: string; path: string; body: string | null };
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  es: Es[];
  es_bodies: unknown[];
  marks_before: string | null;
  marks: string | null;
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/regenerate-creator-analytics-cache-worker.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number | RubyFloat; cases: Case[] };
const nowSeconds = golden.now instanceof RubyFloat ? golden.now.value : golden.now;

const isCap = (sql: string) => /^(select @@max_execution_time|set max_execution_time)/u.test(sql);
const CAST_IDS = new Set(["a seller id of nil", "a seller id given as a float", "a seller id given as a word"]);
// Rails read the seller, then Date.parse accepted a format Node does not read, or rejected the string.
const HANDED_BACK_DATES = new Set([
  "a seller and a date that is not a date",
  "a seller and a date of nil",
  "a date given as a datetime string",
  "a date given in a slash format",
  "a date that exists only in some months",
]);
// Rails fails inside by_state when the seller has no product the views buckets can be keyed to.
const FAILS_IN_ANALYTICS = new Set(["a large seller without products"]);

function pinnedThroughReplay(capLog: string[]) {
  setPinnedSessionFactory(() => {
    const inner = () => replay.client!() as SqlClient;
    return {
      client: {
        $queryRaw: async (query: Prisma.Sql) => {
          if (!isCap(query.sql)) return inner().$queryRaw(query);
          capLog.push(query.sql);
          return [{ "@@max_execution_time": 300000 }];
        },
        $executeRaw: async (query: Prisma.Sql) => {
          if (!isCap(query.sql)) return inner().$executeRaw(query);
          capLog.push(query.sql);
          return 0;
        },
        $transaction: async () => {
          throw new Error("the job opens no transaction of its own");
        },
      } as never,
      close: async () => undefined,
    };
  });
}

// The canned answers were written as JSON floats (`1500.0`); Elasticsearch's client reads those as plain numbers.
const plain = (value: unknown): unknown =>
  value instanceof RubyFloat
    ? value.value
    : Array.isArray(value)
      ? value.map(plain)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
        : value;

let restoreEs: (() => void) | undefined;
afterEach(() => restoreEs?.());

async function run(c: Case, statements: Statement[]) {
  const recording = recordingSidekiqRedis();
  const runtime = createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => nowSeconds,
    newJid: sequentialJids(),
  });
  const sql = sqlReplay(statements.filter((s) => !isCap(s.sql)));
  const capLog: string[] = [];
  pinnedThroughReplay(capLog);
  mainRedis.value = c.marks_before;
  mainRedis.reads = [];
  const queue = plain(c.es_bodies ?? []) as unknown[];
  const sent: Es[] = [];
  restoreEs = setEsSender(async (request) => {
    sent.push({ method: request.method, path: request.path, body: request.body ?? null });
    return { status: 200, body: queue.shift() ?? {} };
  });
  const handler = regenerateCreatorAnalyticsCacheWorkerWith({ now: () => new Date(Math.round(nowSeconds * 1000)) });
  let error: Error | null = null;
  try {
    await asSidekiqJob(() => handler(c.args, contextFor(runtime)), nowSeconds);
  } catch (e) {
    error = e as Error;
  }
  return { error, sql, capLog, recording, sent };
}

const CAP_STATEMENTS = ["select @@max_execution_time", "set max_execution_time = 1200000", "set max_execution_time = 300000"];
// The canned answers do not name an index: compare the model the path names and the body.
const normalised = (es: Es[]) =>
  es.map((r) => ({ method: r.method, index: /\/?([a-z_-]*?)\/_search$/u.exec(r.path)?.[1]?.replace(/^.*-/u, ""), body: JSON.parse(r.body ?? "null") as unknown }));

describe("RegenerateCreatorAnalyticsCacheWorker", () => {
  for (const c of golden.cases.filter((c) => !CAST_IDS.has(c.name) && !HANDED_BACK_DATES.has(c.name))) {
    it(c.name, async () => {
      const { error, sql, capLog, recording, sent } = await run(c, c.statements);

      if (error && !c.error && !FAILS_IN_ANALYTICS.has(c.name)) throw error;
      expect(sql.log).toEqual(sql.expected);
      if (FAILS_IN_ANALYTICS.has(c.name)) expect(error).not.toBeNull();
      else expect(error?.message ?? null).toEqual(c.error?.message ?? null);
      expect(normalised(sent)).toEqual(normalised(c.es));
      expect(capLog).toEqual(c.statements.some((s) => isCap(s.sql)) ? CAP_STATEMENTS : []);
      // The cache version is read by every day that reaches the cache key, never written.
      expect(mainRedis.value).toEqual(c.marks);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => HANDED_BACK_DATES.has(c.name))) {
    it(`hands ${c.name} back after reading the seller`, async () => {
      const { error, sql, sent, recording } = await run(c, c.statements.slice(0, 1));

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual(sql.expected);
      expect(sent).toEqual([]);
      expect(recording.snapshot()).toEqual({});
    });
  }

  for (const c of golden.cases.filter((c) => CAST_IDS.has(c.name))) {
    it(`hands ${c.name} back before any statement`, async () => {
      const { error, sql } = await run(c, []);

      expect(error?.name).toBe("HandBackToRuby");
      expect(sql.log).toEqual([]);
    });
  }

  it("takes a seller id and a date", async () => {
    await expect(regenerateCreatorAnalyticsCacheWorkerWith()([1], contextFor(createJobsRuntime({ sidekiqRedis: recordingSidekiqRedis().redis, bullmqRedis: recordingSidekiqRedis().redis, registry: rubyRuntimeRegistry(), now: () => nowSeconds, newJid: sequentialJids() })))).rejects.toThrow();
  });
});

// The version key the job reads is named once.
describe("analytics cache version key", () => {
  it("is the one the golden recorded", () => {
    expect(VERSION_KEY).toBe("seller_analytics:cache_version");
  });
});
