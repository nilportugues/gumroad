// Replays __fixtures__/server-locks.golden.json (the real sidekiq-unique-jobs server middleware)
// through the Node worker's processor and compares the Redis keyspace at the same points.
// JOBS_REDIS_URL=redis://127.0.0.1:6379/15 npm test; the database is flushed.
import { readFileSync } from "node:fs";

import type { Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createProcessor } from "../../worker/processor.ts";
import type { BridgedJobData } from "./enqueue.ts";
import { JOB_REGISTRY } from "./registry.generated.ts";
import type { JobDefinition } from "./registry-types.ts";
import { createJobsRuntime } from "./runtime.ts";
import { pushToSidekiq } from "./sidekiq/client.ts";
import { buildSidekiqItem } from "./sidekiq/item.ts";
import { type JsonValue, parseRubyJson } from "./sidekiq/ruby-json.ts";

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

type Snapshot = Record<string, { type: string; value?: JsonValue; messages?: string[]; expires: boolean }>;
type GoldenCase = {
  name: string;
  jobs: [string, string, JsonValue[]][];
  body: Record<string, string>;
  before_run?: "flush";
  push_b_inside_a?: boolean;
  pushed: Record<string, { jid: string | null; payload?: string }>;
  before: Snapshot;
  events: string[];
  inside: Record<string, Snapshot>;
  after: Snapshot;
};

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/server-locks.golden.json", import.meta.url), "utf8")) as { now: number; cases: GoldenCase[] };

const base = { file: "", sidekiqJob: true, customLockArgs: false, customRetryIn: false, retriesExhausted: false, runtime: "ruby" } as const;
// The two synthetic classes of generate-server-locks-golden.rb; the others are real jobs.
const registry: Record<string, JobDefinition> = {
  ...(JOB_REGISTRY as Record<string, JobDefinition>),
  WhileExecutingLogJob: { ...base, options: { queue: "default", lock: "while_executing", on_conflict: "log" } },
  UntilAndWhileExecutingJob: {
    ...base,
    options: { queue: "default", retry: 2, lock: "until_and_while_executing", lock_ttl: 300, on_conflict: { client: "log", server: "raise" } },
  },
};

async function snapshot(redis: Redis): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const key of (await redis.keys("*")).sort()) {
    const type = await redis.type(key);
    const expires = (await redis.pttl(key)) > 0;
    if (key === "uniquejobs:changelog") {
      const members = await redis.zrange(key, "0", "-1");
      result[key] = { type, messages: members.map((member) => (JSON.parse(member) as { message: string }).message).sort(), expires };
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

// The changelog zset orders same-score members by their JSON, which embeds per-run timings.
function normalized(state: Snapshot): Snapshot {
  const changelog = state["uniquejobs:changelog"];
  return changelog ? { ...state, "uniquejobs:changelog": { ...changelog, messages: [...(changelog.messages ?? [])].sort() } } : state;
}

describe.skipIf(!url)("runtime locks leave the Redis state sidekiq-unique-jobs leaves", () => {
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
    const nextJid = () => (++seq).toString(16).padStart(24, "0");
    const runtime = createJobsRuntime({ sidekiqRedis: redis, bullmqRedis: redis, registry, now: () => golden.now, newJid: nextJid });
    const jobs = Object.fromEntries(c.jobs.map(([label, className, args]) => [label, { className, args }]));
    const payloads: Record<string, string> = {};

    const pushAndFetch = async (label: string) => {
      const { className, args } = jobs[label]!;
      const definition = registry[className]!;
      const item = buildSidekiqItem({ className, definition, args, jid: nextJid(), now: golden.now });
      expect(await pushToSidekiq(redis, item, golden.now)).toBe(c.pushed[label]!.jid);
      const payload = (await redis.rpop(`queue:${String(item.queue)}`))!;
      expect(payload).toBe(c.pushed[label]!.payload);
      payloads[label] = payload;
    };

    for (const [label] of c.jobs) if (!(c.push_b_inside_a && label === "b")) await pushAndFetch(label);
    if (c.before_run === "flush") await redis.flushdb();
    expect(await snapshot(redis)).toEqual(normalized(c.before));

    const events: string[] = [];
    const inside: Record<string, Snapshot> = {};
    let current = "";
    const processor = createProcessor(
      runtime,
      Object.fromEntries(
        Object.values(jobs).map(({ className }) => [
          className,
          async () => {
            const label = current;
            events.push(`${label} ran`);
            const action = c.body[label];
            if (action === "snapshot") inside[label] = await snapshot(redis);
            else if (action === "raise") {
              const error = new Error(`boom from ${label}`);
              error.name = "ArgumentError";
              throw error;
            } else if (action?.startsWith("run ")) {
              const other = action.slice(4);
              if (c.push_b_inside_a) await pushAndFetch(other);
              inside[`${label} before ${other}`] = await snapshot(redis);
              await runServer(other);
              inside[label] = await snapshot(redis);
            }
          },
        ]),
      ),
    );

    const runServer = async (label: string) => {
      const previous = current;
      current = label;
      try {
        await processor({ data: { sidekiq: payloads[label]! }, attemptsMade: 0, id: label } as Job<BridgedJobData>);
        events.push(`${label} returned`);
      } catch (error) {
        const { name, message } = error as Error;
        events.push(`${label} raised ${name}: ${message}`);
      } finally {
        current = previous;
      }
    };

    await runServer("a");
    expect(events).toEqual(c.events);
    expect(Object.fromEntries(Object.entries(inside).map(([key, state]) => [key, state]))).toEqual(
      Object.fromEntries(Object.entries(c.inside).map(([key, state]) => [key, normalized(state)])),
    );
    expect(await snapshot(redis)).toEqual(normalized(c.after));
    await runtime.close();
  });
});
