// The connections and clock behind enqueue(). One per process; tests build their own.
import { randomBytes } from "node:crypto";

import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { BULLMQ_PREFIX } from "./bullmq/options.ts";
import { bullmqRedisUrl, createRedis, sidekiqRedisUrl } from "./redis.ts";
import { closeBlockingConnections } from "./sidekiq/unique-lock.ts";
import { JOB_REGISTRY } from "./registry.generated.ts";
import type { JobDefinition } from "./registry-types.ts";

export type JobsRuntime = {
  registry: Readonly<Record<string, JobDefinition>>;
  sidekiqRedis: Redis;
  bullmqRedis: Redis;
  queue(name: string): Queue;
  // Epoch seconds as a float, like Ruby's Time.now.to_f.
  now(): number;
  // SecureRandom.hex(12), Sidekiq's jid.
  newJid(): string;
  close(): Promise<void>;
};

export function createJobsRuntime(options: {
  sidekiqRedis: Redis;
  bullmqRedis: Redis;
  registry?: Readonly<Record<string, JobDefinition>>;
  prefix?: string;
  now?: () => number;
  newJid?: () => string;
}): JobsRuntime {
  const queues = new Map<string, Queue>();
  return {
    registry: options.registry ?? JOB_REGISTRY,
    sidekiqRedis: options.sidekiqRedis,
    bullmqRedis: options.bullmqRedis,
    queue(name) {
      let queue = queues.get(name);
      if (!queue) {
        queue = new Queue(name, { connection: options.bullmqRedis, prefix: options.prefix ?? BULLMQ_PREFIX });
        queues.set(name, queue);
      }
      return queue;
    },
    now: options.now ?? (() => Date.now() / 1000),
    newJid: options.newJid ?? (() => randomBytes(12).toString("hex")),
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      closeBlockingConnections(options.sidekiqRedis);
    },
  };
}

let defaultRuntime: JobsRuntime | undefined;

export function jobsRuntime(): JobsRuntime {
  defaultRuntime ??= createJobsRuntime({ sidekiqRedis: createRedis(sidekiqRedisUrl()), bullmqRedis: createRedis(bullmqRedisUrl()) });
  return defaultRuntime;
}
