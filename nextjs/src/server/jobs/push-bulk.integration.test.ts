// Replays __fixtures__/push-bulk.golden.json (generate-push-bulk-golden.rb, the real gems) against a
// real Redis and compares the whole keyspace: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test.
// The database is flushed between tests.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueWith } from "./enqueue.ts";
import { performBulkWith, type PushBulkItems, pushBulkWith } from "./push-bulk.ts";
import { JOB_REGISTRY } from "./registry.generated.ts";
import type { JobDefinition } from "./registry-types.ts";
import { createJobsRuntime } from "./runtime.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "./sidekiq/ruby-json.ts";

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

type Snapshot = Record<string, { type: string; value?: JsonValue; messages?: string[]; expires: boolean }>;
type Case = {
  name: string;
  push?: PushBulkItems;
  perform_bulk?: { class: string; args: JsonValue[][]; set?: Record<string, JsonValue>; batch_size?: number };
  before?: [string, JsonValue[]][];
  jids: (string | null)[] | null;
  error: { class: string; message: string } | null;
  redis: Snapshot;
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/push-bulk.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  node_owned: string[];
  cases: Case[];
};

const base = { file: "", sidekiqJob: true, customLockArgs: false, customRetryIn: false, retriesExhausted: false } as const;
const registry: Record<string, JobDefinition> = { ...(JOB_REGISTRY as Record<string, JobDefinition>) };
for (const name of ["SendToElasticsearchWorker", "UpdateUserBalanceStatsCacheWorker", "UpdateCachedSalesRelatedProductsInfosJob", "PushNotificationWorker"]) {
  registry[name] = { ...registry[name]!, runtime: "ruby" };
}
registry.NodeOwnedBulkJob = { ...base, runtime: "node", options: { retry: 2, queue: "low", lock: "until_executed" } };
const PREFIX = "ws37test";

// Zset scores the golden writes as `1761955230.0` parse as RubyFloat; compare them as numbers.
function plain(value: unknown): unknown {
  if (value instanceof RubyFloat) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

// The view of Redis the generator records.
async function snapshot(redis: Redis): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const key of (await redis.keys("*")).sort()) {
    if (key.startsWith(`${PREFIX}:`)) continue;
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

describe.skipIf(!url)("Sidekiq::Client.push_bulk against Redis", () => {
  const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    let seq = 0;
    const runtime = createJobsRuntime({
      sidekiqRedis: redis,
      bullmqRedis: redis,
      registry,
      prefix: PREFIX,
      now: () => golden.now,
      newJid: () => (++seq).toString(16).padStart(24, "0"),
    });
    try {
      for (const [klass, args] of c.before ?? []) await enqueueWith(runtime, klass, args);

      let jids: (string | null)[] | null = null;
      let error: { class: string; message: string } | null = null;
      try {
        if (c.push) jids = await pushBulkWith(runtime, c.push);
        else {
          const bulk = c.perform_bulk!;
          jids = await performBulkWith(runtime, bulk.class, bulk.args, { ...(bulk.batch_size === undefined ? {} : { batchSize: bulk.batch_size }), ...(bulk.set ? { set: bulk.set } : {}) });
        }
      } catch (e) {
        error = { class: (e as Error).name, message: (e as Error).message };
      }
      expect(error).toEqual(c.error);

      const state = await snapshot(redis);
      const className = c.push?.class ?? c.perform_bulk?.class;
      if (!golden.node_owned.includes(String(className))) {
        expect(jids).toEqual(c.jids);
        expect(state).toEqual(plain(c.redis));
        return;
      }

      // SidekiqNodeBridge diverts each locked item to its inbox (and perform_bulk returns nil for
      // it); Node adds the same payload to BullMQ and returns its jid.
      const { "nextjs:bridge:inbox": inbox, ...rubyRest } = c.redis;
      const bridged = [...((inbox?.value as string[]) ?? [])].reverse();
      const jobs = await runtime.queue("low").getJobs(["delayed", "wait"]);
      const byJid = new Map(jobs.map((job) => [job.id, (job.data as { sidekiq: string }).sidekiq]));
      expect(jids!.filter((jid) => jid !== null).map((jid) => byJid.get(jid!))).toEqual(bridged);
      expect(jids!.filter((jid) => jid !== null)).toHaveLength(bridged.length);
      expect(c.jids).toEqual(c.jids!.map(() => null));
      expect(state).toEqual(plain(rubyRest));
    } finally {
      await runtime.close();
    }
  });
});
