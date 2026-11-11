// Replays a search.golden.json job case against a Node handler: the same SQL answers (sql-replay),
// the same Elasticsearch answers (a recording EsSender), and a Sidekiq Redis that records pushes.
import type { Redis } from "ioredis";
import { expect } from "vitest";

import { asSidekiqJob, sequentialJids } from "../../../worker/jobs/__fixtures__/golden.ts";
import { sqlReplay } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import type { JobHandler } from "../../../worker/jobs/types.ts";
import type { JobDefinition } from "../../jobs/registry-types.ts";
import { JOB_REGISTRY } from "../../jobs/registry.generated.ts";
import { createJobsRuntime, type JobsRuntime } from "../../jobs/runtime.ts";
import type { SidekiqItem } from "../../jobs/sidekiq/item.ts";
import { type JsonValue, RubyFloat } from "../../jobs/sidekiq/ruby-json.ts";
import { type EsRequest, setEsSender } from "../transport.ts";

import type { EsRequestRecord, SearchCase } from "./search-golden.ts";
import { searchGolden } from "./search-golden.ts";

// The Ruby side records the request line Faraday sent: path, then the query in key order.
function record(request: EsRequest): EsRequestRecord {
  const query =
    request.query && Object.keys(request.query).length > 0 ? new URLSearchParams(request.query).toString() : null;
  return { method: request.method, path: request.path, query, body: request.body ?? null };
}

export function esRecorder(responses: [number, JsonValue][] = []) {
  const queue = [...responses];
  const requests: EsRequestRecord[] = [];
  const restore = setEsSender(async (request) => {
    requests.push(record(request));
    const [status, body] = queue.shift() ?? [200, {}];
    return { status, body };
  });
  return { requests, restore };
}

type Zset = Map<string, number>;

// Sidekiq's lock-free pushes (atomic_push), in the generator's snapshot shape.
export function fakeSidekiqRedis() {
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Zset>();
  const pipeline = () => {
    const ops: (() => void)[] = [];
    const chain = {
      sadd(key: string, member: string) {
        ops.push(() => sets.set(key, (sets.get(key) ?? new Set()).add(member)));
        return chain;
      },
      lpush(key: string, value: string) {
        ops.push(() => lists.set(key, [value, ...(lists.get(key) ?? [])]));
        return chain;
      },
      zadd(key: string, score: number | string, member: string) {
        ops.push(() => zsets.set(key, (zsets.get(key) ?? new Map()).set(member, Number(score))));
        return chain;
      },
      async exec() {
        ops.forEach((op) => op());
        return ops.map(() => [null, 1]);
      },
    };
    return chain;
  };
  const redis = new Proxy(
    { pipeline },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        if (property === "then") return undefined;
        throw new Error(`fakeSidekiqRedis does not support ${String(property)}`);
      },
    },
  ) as unknown as Redis;
  const snapshot = () => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of lists) result[key] = { type: "list", value, expires: false };
    for (const [key, value] of sets) result[key] = { type: "set", value: [...value].sort(), expires: false };
    for (const [key, value] of zsets)
      result[key] = { type: "zset", value: [...value].sort((a, b) => a[1] - b[1]), expires: false };
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  return { redis, snapshot };
}

// RubyFloat → number, so snapshots compare by value.
export function plain(value: unknown): unknown {
  if (value instanceof RubyFloat) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

// Jobs the cases enqueue run in Ruby while they are recorded, so the Sidekiq payload is what they compare.
export function rubyRegistry(...classes: string[]): Record<string, JobDefinition> {
  const registry: Record<string, JobDefinition> = { ...JOB_REGISTRY };
  for (const name of classes) registry[name] = { ...registry[name]!, runtime: "ruby" };
  return registry;
}

export function goldenSearchRuntime(sidekiqRedis: Redis, registry: Record<string, JobDefinition>): JobsRuntime {
  return createJobsRuntime({
    sidekiqRedis,
    bullmqRedis: sidekiqRedis,
    now: () => searchGolden.now,
    newJid: sequentialJids(),
    registry,
  });
}

export async function replayJobCase(
  golden: SearchCase,
  handler: JobHandler,
  options: { registry?: Record<string, JobDefinition>; redis?: { redis: Redis; snapshot: () => unknown } } = {},
) {
  const sql = sqlReplay(golden.statements);
  const es = esRecorder(golden.es_responses ?? []);
  const sidekiq = options.redis ?? fakeSidekiqRedis();
  const runtime = goldenSearchRuntime(sidekiq.redis, options.registry ?? JOB_REGISTRY);
  let error: { class: string; message: string } | null = null;
  try {
    await asSidekiqJob(
      () => handler(golden.args ?? [], { jid: "f".repeat(24), item: {} as SidekiqItem, attemptsMade: 0, runtime }),
      searchGolden.now,
    );
  } catch (e) {
    error = { class: (e as Error).name, message: (e as Error).message };
    if (process.env.DEBUG_SEARCH) console.log(e);
  } finally {
    es.restore();
  }
  expect(sql.log).toEqual(sql.expected);
  expect(es.requests).toEqual(golden.es);
  expect(error).toEqual(golden.error);
  expect(plain(await sidekiq.snapshot())).toEqual(plain(golden.redis));
}
