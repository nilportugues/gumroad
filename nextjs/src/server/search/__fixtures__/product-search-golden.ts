// Loads product-search.golden.json (generate-product-search-golden.rb) and replays a case: the same
// SQL answers, the same Elasticsearch answers, a fresh query cache, and Sidekiq on a real Redis
// when the case leaves anything there.
import { readFileSync } from "node:fs";

import type { Redis } from "ioredis";
import { expect } from "vitest";

import { createJobsRuntime, type JobsRuntime } from "../../jobs/runtime.ts";
import { JOB_REGISTRY } from "../../jobs/registry.generated.ts";
import type { JobDefinition } from "../../jobs/registry-types.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../../jobs/sidekiq/ruby-json.ts";
import { withJobsRuntime } from "../../models/concerns/job-runtime.ts";
import { sequentialJids } from "../../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import type { ProductDocumentDeps } from "../documents/product.ts";
import { esJson } from "../es-json.ts";
import { withQueryCache } from "../query-cache.ts";
import { esRecorder } from "./job-harness.ts";
import type { EsRequestRecord } from "./search-golden.ts";

export type Snapshot = Record<string, { type: string; value?: JsonValue; messages?: string[]; expires: boolean }>;
export type ProductCase = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  result: JsonValue;
  statements: Statement[];
  es: EsRequestRecord[];
  es_responses: [number, JsonValue][];
  features: [string, string | null][];
  redis: Snapshot;
  trailing_key?: string;
};

export const productGolden = parseRubyJson(readFileSync(new URL("product-search.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  es_index: string;
  search_fields: string[];
  attribute_to_search_fields: Record<string, string | string[]>;
  reindex_scroll_size: number;
  documents: ProductCase[];
  jobs: Record<string, ProductCase[]>;
  user_product_index_updates: ProductCase[];
};

const nowSeconds = () => { const now = productGolden.now as unknown; return now instanceof RubyFloat ? now.value : Number(now); };

export const goldenDeps = (c: ProductCase): ProductDocumentDeps => ({
  now: () => new Date(nowSeconds() * 1000),
  featureActive: async (name, actor) => c.features.some(([feature, featureActor]) => feature === name && (featureActor === null || featureActor === actor)),
});

// The classes these cases enqueue ran in Ruby when they were recorded.
export function recordedRegistry(): Record<string, JobDefinition> {
  const registry: Record<string, JobDefinition> = { ...JOB_REGISTRY };
  registry.SendToElasticsearchWorker = { ...registry.SendToElasticsearchWorker!, runtime: "ruby" };
  return registry;
}

export function goldenRuntime(redis: Redis): JobsRuntime {
  return createJobsRuntime({ sidekiqRedis: redis, bullmqRedis: redis, registry: recordedRegistry(), now: nowSeconds, newJid: sequentialJids() });
}

const plain = (value: unknown): unknown => {
  if (value instanceof RubyFloat) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
};

// The generator's view of Redis.
export async function snapshot(redis: Redis): Promise<unknown> {
  const result: Snapshot = {};
  for (const key of (await redis.keys("*")).sort()) {
    const type = await redis.type(key);
    const expires = (await redis.pttl(key)) > 0;
    if (key === "uniquejobs:changelog") {
      const members = await redis.zrange(key, "0", "-1");
      result[key] = { type, messages: members.map((member) => (JSON.parse(member) as { message: string }).message), expires };
      continue;
    }
    let value: JsonValue;
    if (type === "string") value = await redis.get(key);
    else if (type === "list") value = await redis.lrange(key, 0, -1);
    else if (type === "set") value = (await redis.smembers(key)).sort();
    else if (type === "hash") value = await redis.hgetall(key);
    else {
      const flat = await redis.zrange(key, "0", "-1", "WITHSCORES");
      value = [];
      for (let i = 0; i < flat.length; i += 2) value.push([flat[i]!, Number(flat[i + 1])]);
    }
    result[key] = { type, value, expires };
  }
  return result;
}

// Runs `body` as the recorded case ran and compares statements, requests, error, result and Redis.
export async function replayProductCase(
  c: ProductCase,
  redis: Redis | null,
  body: (deps: ProductDocumentDeps) => Promise<JsonValue | void>,
  options: { statements?: Statement[] } = {},
): Promise<void> {
  const statements = options.statements ?? c.statements;
  const sql = sqlReplay(statements);
  const es = esRecorder(c.es_responses);
  // Without Redis (documents), anything reaching Sidekiq fails the case.
  if (redis) {
    await redis.flushdb();
    if (c.trailing_key) await redis.set(c.trailing_key, "1", "EX", 600);
  }
  const runtime = redis ? goldenRuntime(redis) : null;
  let error: { class: string; message: string } | null = null;
  let result: JsonValue | void = undefined;
  try {
    const run = () => withQueryCache(() => body(goldenDeps(c)));
    result = await (runtime ? withJobsRuntime(runtime, run) : run());
  } catch (e) {
    error = { class: (e as Error).name, message: (e as Error).message };
    if (process.env.DEBUG_SEARCH) console.log(e);
  } finally {
    es.restore();
    await runtime?.close();
  }
  expect(sql.log).toEqual(statements.map((s) => s.sql));
  expect(es.requests).toEqual(c.es);
  expect(error).toEqual(c.error);
  if (result !== undefined && c.error === null) expect(esJson(result as JsonValue)).toEqual(esJson(c.result));
  expect(redis ? plain(await snapshot(redis)) : {}).toEqual(plain(c.redis));
}
