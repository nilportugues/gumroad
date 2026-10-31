// Replays reputation.golden.json (generate-reputation-golden.rb): the same SQL, the same $redis
// state (Flipper read, version, snapshot) and the same memcached traffic and entries as Rails.
// Needs a scratch Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/12 npm test.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CacheTransport } from "../../server/cache/transport.ts";
import { createMemoryTransport } from "../../server/cache/transport.ts";
import { createRailsCache } from "../../server/cache/rails-cache.ts";
import { resetFlipperStateForTesting } from "../../server/infra/flipper.ts";
import { JOB_REGISTRY } from "../../server/jobs/registry.generated.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, sequentialJids } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { warmSellerReputationSummaryJobWith } from "./warm-seller-reputation-summary-job.ts";

type Case = {
  name: string;
  args: JsonValue[];
  seed: Record<string, string | Record<string, string>>;
  runs: number;
  error?: { message: string };
  statements: Statement[];
  redis: Record<string, { value: string | Record<string, string>; ttl: number }>;
  cache_ops: (string | number)[][];
  memcached: Record<string, { value: string; flags: number; exptime: number }>;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/reputation.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  namespace: string;
  cases: Case[];
};

function recordingTransport(inner: CacheTransport, record: (op: (string | number)[]) => void): CacheTransport {
  return {
    async get(key) {
      record(["get", key]);
      return inner.get(key);
    },
    async set(key, value, flags, exptime) {
      record(["set", key, flags, exptime, value.toString("hex")]);
      return inner.set(key, value, flags, exptime);
    },
    async add(key, value, flags, exptime) {
      record(["add", key, flags, exptime, value.toString("hex")]);
      return inner.add(key, value, flags, exptime);
    },
    async delete(key) {
      record(["delete", key]);
      return inner.delete(key);
    },
    close: () => inner.close(),
  };
}

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let redis: Redis | undefined;
beforeAll(() => {
  if (url) redis = new Redis(url);
});
afterAll(async () => {
  if (!redis) return;
  await redis.flushdb();
  redis.disconnect();
});
beforeEach(() => resetFlipperStateForTesting());

describe("WarmSellerReputationSummaryJob", () => {
  it.skipIf(!url).each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const r = redis!;
    await r.flushdb();
    for (const [key, value] of Object.entries(c.seed)) {
      if (typeof value === "string") await r.set(key, value);
      else await r.hset(key, value);
    }
    const sql = sqlReplay(c.statements);
    const memory = createMemoryTransport(() => golden.now);
    const ops: (string | number)[][] = [];
    const cache = createRailsCache({ transport: recordingTransport(memory, (op) => ops.push(op)), namespace: golden.namespace, now: () => golden.now });
    const sidekiq = recordingSidekiqRedis();
    const runtime = createJobsRuntime({ sidekiqRedis: sidekiq.redis, bullmqRedis: sidekiq.redis, registry: JOB_REGISTRY, now: () => golden.now, newJid: sequentialJids() });
    const handler = warmSellerReputationSummaryJobWith({ now: () => new Date(Math.round(golden.now * 1000)), redis: () => r, cache: () => cache });

    let error: unknown = null;
    try {
      for (let i = 0; i < c.runs; i++) await asSidekiqJob(() => handler(c.args, contextFor(runtime)), golden.now);
    } catch (e) {
      error = e;
    }
    expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
    expect(sql.log).toEqual(sql.expected);

    const state: Case["redis"] = {};
    for (const key of (await r.keys("*")).sort()) {
      const value = (await r.type(key)) === "hash" ? await r.hgetall(key) : (await r.get(key))!;
      state[key] = { value, ttl: await r.ttl(key) };
    }
    expect(state).toEqual(c.redis);
    expect(ops).toEqual(c.cache_ops);
    const contents = Object.fromEntries(
      [...memory.entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, e]) => [key, { value: e.value.toString("hex"), flags: e.flags, exptime: e.exptime }]),
    );
    expect(contents).toEqual(c.memcached);
  });
});
