// Runs against a real Redis: JOBS_REDIS_URL=redis://127.0.0.1:6379/15 npm test.
// The database is flushed between tests, so never point it at one that matters.
import { readFileSync } from "node:fs";

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { BRIDGE_INBOX, runBridge } from "../../worker/bridge.ts";
import { syncCronSchedulers } from "../../worker/cron.ts";
import { startWorker, type StartedWorker } from "../../worker/index.ts";
import type { JobHandler } from "../../worker/jobs/types.ts";

import { enqueueWith } from "./enqueue.ts";
import type { JobDefinition } from "./registry-types.ts";
import { JOB_REGISTRY } from "./registry.generated.ts";
import { createJobsRuntime, type JobsRuntime } from "./runtime.ts";
import { pushToSidekiq } from "./sidekiq/client.ts";
import { buildSidekiqItem } from "./sidekiq/item.ts";
import { dumpRubyJson, type JsonValue, parseRubyJson } from "./sidekiq/ruby-json.ts";

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/u.test(url))
  throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

const base = {
  file: "",
  sidekiqJob: true,
  customLockArgs: false,
  customRetryIn: false,
  retriesExhausted: false,
} as const;
const registry: Record<string, JobDefinition> = {
  ...(JOB_REGISTRY as Record<string, JobDefinition>),
  NodeLockedJob: { ...base, runtime: "node", options: { retry: 1, queue: "low", lock: "until_executed" } },
  // Same class name as NodeLockedJob would have on the Ruby side before it was ported.
  RubyLockedJob: { ...base, runtime: "ruby", options: { retry: 1, queue: "low", lock: "until_executed" } },
  RetryStubJob: { ...base, runtime: "ruby", options: { retry: false, queue: "low" } },
  RetryInJob: {
    ...base,
    runtime: "node",
    customRetryIn: true,
    retriesExhausted: true,
    options: { retry: 1, queue: "low", lock: "until_executed" },
  },
  UntilExecutedWithTtlJob: {
    ...base,
    runtime: "ruby",
    options: { retry: 5, queue: "default", lock: "until_executed", lock_ttl: 900 },
  },
};
registry.RetryFalseJob = registry.RetryStubJob!;

type Snapshot = Record<string, { type: string; value?: JsonValue; messages?: string[]; expires: boolean }>;

// The same view of Redis that __fixtures__/generate-sidekiq-golden.rb records.
async function snapshot(redis: Redis): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const key of (await redis.keys("*")).sort()) {
    const type = await redis.type(key);
    const expires = (await redis.pttl(key)) > 0;
    if (key === "uniquejobs:changelog") {
      const members = await redis.zrange(key, "0", "-1");
      result[key] = {
        type,
        messages: members.map((member) => (JSON.parse(member) as { message: string }).message),
        expires,
      };
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

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!url)("jobs against Redis", () => {
  const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
  let runtime: JobsRuntime;
  let worker: StartedWorker | undefined;
  const ran: { className: string; args: JsonValue[]; jid: string }[] = [];
  const recordingHandler =
    (className: string): JobHandler =>
    async (args, { jid }) => {
      ran.push({ className, args, jid });
    };

  beforeEach(async () => {
    await redis.flushdb();
    ran.length = 0;
    runtime = createJobsRuntime({ sidekiqRedis: redis, bullmqRedis: redis, registry, prefix: "ws05test" });
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await runtime.close();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  describe("Sidekiq pushes leave the Redis state Ruby leaves", () => {
    const golden = parseRubyJson(
      readFileSync(new URL("./__fixtures__/sidekiq-wire.golden.json", import.meta.url), "utf8"),
    ) as unknown as {
      now: number;
      pushes: {
        name: string;
        class: string;
        args: JsonValue[];
        in?: number;
        queue?: string;
        set?: Record<string, string | number>;
        repeat?: boolean;
        jids: (string | null)[];
        redis: Snapshot;
      }[];
    };

    it.each(golden.pushes.map((push) => [push.name, push] as const))("%s", async (_name, push) => {
      let seq = 0;
      const now = golden.now;
      const jids: (string | null)[] = [];
      for (let i = 0; i < (push.repeat ? 2 : 1); i++) {
        const item = buildSidekiqItem({
          className: push.class,
          definition: registry[push.class]!,
          args: push.args,
          jid: (++seq).toString(16).padStart(24, "0"),
          now,
          ...(push.in === undefined ? {} : { at: now + push.in }),
          ...(push.queue === undefined ? {} : { queue: push.queue }),
          ...(push.set === undefined ? {} : { set: push.set }),
        });
        jids.push(await pushToSidekiq(redis, item, now));
      }
      // Ruby's second push draws the next jid too, so only the first matches by value.
      expect(jids.map((jid) => jid !== null)).toEqual(push.jids.map((jid) => jid !== null));
      expect(await snapshot(redis)).toEqual(push.redis);
    });
  });

  it("runs a ported low job end to end on BullMQ", async () => {
    worker = await startWorker({
      runtime,
      queues: ["low"],
      handlers: { LogResendEventJob: recordingHandler("LogResendEventJob") },
      prefix: "ws05test",
    });
    const jid = await enqueueWith(runtime, "LogResendEventJob", [{ type: "email.delivered" }]);
    const run = await waitFor(() => ran.find((entry) => entry.jid === jid));
    expect(run.args).toEqual([{ type: "email.delivered" }]);
    // Nothing reached Sidekiq.
    expect(await redis.exists("queue:low")).toBe(0);
  });

  it("delays a ported job like perform_in", async () => {
    worker = await startWorker({
      runtime,
      queues: ["low"],
      handlers: { LogResendEventJob: recordingHandler("LogResendEventJob") },
      prefix: "ws05test",
    });
    const enqueuedAt = Date.now();
    await enqueueWith(runtime, "LogResendEventJob", [1], { delaySeconds: 1 });
    await waitFor(() => ran[0]);
    expect(Date.now() - enqueuedAt).toBeGreaterThanOrEqual(1000);
  });

  it("deduplicates a Node-run until_executed job against Ruby's lock keys, and releases after the run", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    worker = await startWorker({
      runtime,
      queues: ["low"],
      handlers: {
        NodeLockedJob: async (args, context) => {
          await blocked;
          await recordingHandler("NodeLockedJob")(args, context);
        },
      },
      prefix: "ws05test",
    });

    const first = await enqueueWith(runtime, "NodeLockedJob", [7]);
    expect(first).not.toBeNull();
    expect(await enqueueWith(runtime, "NodeLockedJob", [7])).toBeNull();
    expect(await enqueueWith(runtime, "NodeLockedJob", [8])).not.toBeNull();

    // A Ruby-side push of the same class, queue and args computes the same digest and is dropped.
    const item = buildSidekiqItem({
      className: "NodeLockedJob",
      definition: registry.RubyLockedJob!,
      args: [7],
      jid: "ruby-side",
      now: runtime.now(),
    });
    expect(await pushToSidekiq(redis, item, runtime.now())).toBeNull();

    release();
    await waitFor(() => (ran.length === 2 ? ran : undefined));
    await waitFor(async () => ((await redis.zcard("uniquejobs:digests")) === 0 ? true : undefined));
    expect(await enqueueWith(runtime, "NodeLockedJob", [7])).not.toBeNull();
  });

  it("forwards a job Rails pushed to the bridge inbox", async () => {
    worker = await startWorker({
      runtime,
      queues: ["low"],
      handlers: { LogResendEventJob: recordingHandler("LogResendEventJob") },
      prefix: "ws05test",
    });
    const item = buildSidekiqItem({
      className: "LogResendEventJob",
      definition: registry.LogResendEventJob!,
      args: [12345678901234567n],
      jid: "abc123abc123abc123abc123",
      now: runtime.now(),
    });
    await redis.lpush(BRIDGE_INBOX, dumpRubyJson(item));

    const abort = new AbortController();
    const blocking = redis.duplicate();
    const bridge = runBridge(runtime, blocking, abort.signal);
    const run = await waitFor(() => ran[0]);
    abort.abort();
    await bridge;
    blocking.disconnect();

    expect(run).toEqual({
      className: "LogResendEventJob",
      args: [12345678901234567n],
      jid: "abc123abc123abc123abc123",
    });
    expect(await redis.llen("nextjs:bridge:processing")).toBe(0);
  });

  it("delays a retry by sidekiq_retry_in and runs sidekiq_retries_exhausted after the last one", async () => {
    const exhausted: { msg: JsonValue; message: string; digests: number }[] = [];
    worker = await startWorker({
      runtime,
      queues: ["low"],
      handlers: {
        RetryInJob: async (args, context) => {
          await recordingHandler("RetryInJob")(args, context);
          throw new Error(`attempt ${context.attemptsMade}`);
        },
      },
      hooks: {
        // One second (plus jitter) instead of Sidekiq's 15+.
        retryIn: { RetryInJob: () => 1 },
        retriesExhausted: {
          RetryInJob: async (msg, error) => {
            // JobRetry runs outside the unique-jobs middleware: the until_executed lock is gone.
            exhausted.push({
              msg,
              message: (error as Error).message,
              digests: await redis.zcard("uniquejobs:digests"),
            });
          },
        },
      },
      prefix: "ws05test",
    });
    const jid = await enqueueWith(runtime, "RetryInJob", [5]);
    const [entry] = await waitFor(() => (exhausted.length ? exhausted : undefined), 25_000);
    expect(ran.map((run) => run.jid)).toEqual([jid, jid]);
    expect(entry!.message).toBe("attempt 1");
    expect(entry!.digests).toBe(0);
    expect(entry!.msg).toMatchObject({
      class: "RetryInJob",
      args: [5],
      retry_count: 1,
      error_message: "attempt 1",
      error_class: "Error",
    });
    const failed = await runtime.queue("low").getFailed();
    expect(failed.map((job) => job.id)).toEqual([jid]);
  }, 30_000);

  it("schedules Node-owned cron entries and removes stale ones", async () => {
    const schedule = [{ name: "node_cron", cron: "*/5 * * * *", class: "NodeLockedJob", args: ["x"] }];
    await syncCronSchedulers(runtime, ["low"], schedule);
    const [scheduler] = await runtime.queue("low").getJobSchedulers();
    expect(scheduler).toMatchObject({ key: "node_cron", pattern: "*/5 * * * *", tz: "UTC" });

    await syncCronSchedulers(runtime, ["low"], []);
    expect(await runtime.queue("low").getJobSchedulers()).toEqual([]);
  });
});
