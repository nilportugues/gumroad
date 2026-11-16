import { Redis } from "ioredis";

import { getConfig, getRequiredConfig } from "../infra/config.ts";

// Same server and DB the Rails Sidekiq client uses (`redis://#{SIDEKIQ_REDIS_HOST}`), so the
// queues and unique-jobs locks are the ones Ruby reads.
export function sidekiqRedisUrl(): string {
  return `redis://${getRequiredConfig("SIDEKIQ_REDIS_HOST")}`;
}

// BullMQ may share the Sidekiq server (its keys live under `bull:`) or get its own.
export function bullmqRedisUrl(): string {
  return getConfig("BULLMQ_REDIS_URL") || sidekiqRedisUrl();
}

// BullMQ workers block on Redis and require maxRetriesPerRequest: null.
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
