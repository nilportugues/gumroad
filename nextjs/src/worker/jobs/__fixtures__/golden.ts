// Loads standalone-jobs.golden.json (see generate-standalone-jobs-golden.rb) and the Redis
// doubles the job tests replay it against.
import { readFileSync } from "node:fs";

import type { Redis } from "ioredis";

import { JOB_REGISTRY } from "../../../server/jobs/registry.generated.ts";
import type { JobDefinition } from "../../../server/jobs/registry-types.ts";
import { createJobsRuntime, type JobsRuntime } from "../../../server/jobs/runtime.ts";
import type { SidekiqItem } from "../../../server/jobs/sidekiq/item.ts";
import { type JsonValue, parseRubyJson } from "../../../server/jobs/sidekiq/ruby-json.ts";
import { SIDEKIQ_EXECUTOR, withExecutor } from "../../../server/models/runtime/query-cache.ts";
import type { JobContext } from "../types.ts";

export type RedisSnapshot = Record<string, { type: string; value?: JsonValue; count?: number; expires: boolean }>;
export type PerformCase = { name?: string; args: JsonValue[]; error: { class: string; message: string } | null; redis: RedisSnapshot };

export type Golden = {
  now: number;
  log_sendgrid_event_worker: PerformCase[];
  sync_stripe_business_profile_url_worker: PerformCase[];
  enqueue_marketing_x_reconnect_email_job: PerformCase[];
  handle_sns_aws_config_event_worker: PerformCase[];
  update_currencies_worker: { name: string; body: string; writes: [string, string][]; error: { class: string } | null }[];
  float_to_s: [string, string][];
};

export const golden = parseRubyJson(readFileSync(new URL("standalone-jobs.golden.json", import.meta.url), "utf8")) as unknown as Golden;

// SecureRandom.hex(12) as the generator stubs it.
export function sequentialJids(): () => string {
  let seq = 0;
  return () => (++seq).toString(16).padStart(24, "0");
}

export function goldenRuntime(sidekiqRedis: Redis, registry?: Record<string, JobDefinition>): JobsRuntime {
  return createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry, now: () => golden.now, newJid: sequentialJids() });
}

// The registry with every class still run by Ruby, so a golden recorded before a port keeps
// checking the Sidekiq payload the enqueue would build.
export function rubyRuntimeRegistry(): Record<string, JobDefinition> {
  return Object.fromEntries(Object.entries(JOB_REGISTRY).map(([name, definition]) => [name, { ...definition, runtime: "ruby" } as JobDefinition]));
}

// Runs a handler as the processor does: inside the Sidekiq executor, so its reads share the query
// cache. The generators freeze the clock, so mysql2_proxy's proxy_delay never runs out.
export function asSidekiqJob<T>(fn: () => Promise<T>, nowSeconds: number): Promise<T> {
  return withExecutor(fn, { ...SIDEKIQ_EXECUTOR, now: () => nowSeconds * 1000 });
}

export function contextFor(runtime: JobsRuntime): JobContext {
  return { jid: "f".repeat(24), item: {} as SidekiqItem, attemptsMade: 0, runtime };
}

// A Sidekiq Redis that records the lock-free pushes Sidekiq::Client#atomic_push makes, in the
// generator's snapshot shape. Anything else (unique-jobs Lua) throws, so a test cannot pass by
// skipping a lock.
export function recordingSidekiqRedis(): { redis: Redis; snapshot(): RedisSnapshot } {
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const pipeline = () => {
    const ops: (() => void)[] = [];
    const chain = {
      sadd(key: string, member: string) {
        ops.push(() => sets.set(key, (sets.get(key) ?? new Set()).add(member)));
        return chain;
      },
      srem(key: string, member: string) {
        ops.push(() => {
          sets.get(key)?.delete(member);
          if (sets.get(key)?.size === 0) sets.delete(key);
        });
        return chain;
      },
      lpush(key: string, value: string) {
        ops.push(() => lists.set(key, [value, ...(lists.get(key) ?? [])]));
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
        throw new Error(`recordingSidekiqRedis does not support ${String(property)}`);
      },
    },
  ) as unknown as Redis;
  const snapshot = (): RedisSnapshot => {
    const result: RedisSnapshot = {};
    for (const [key, value] of lists) result[key] = { type: "list", value, expires: false };
    for (const [key, value] of sets) result[key] = { type: "set", value: [...value].sort(), expires: false };
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  return { redis, snapshot };
}

// The generator's view of a real Redis: every key, with the changelog reduced to its size.
export async function snapshotRedis(redis: Redis): Promise<RedisSnapshot> {
  const result: RedisSnapshot = {};
  for (const key of (await redis.keys("*")).sort()) {
    const type = await redis.type(key);
    const expires = (await redis.pttl(key)) > 0;
    if (key === "uniquejobs:changelog") {
      result[key] = { type, count: await redis.zcard(key), expires };
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
