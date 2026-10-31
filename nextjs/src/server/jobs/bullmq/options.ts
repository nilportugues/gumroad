// Maps a job's Sidekiq options onto BullMQ's. One BullMQ queue per Sidekiq queue, same names,
// under BullMQ's own `bull:` key prefix so nothing collides with Sidekiq's keys.
import type { JobsOptions } from "bullmq";

import type { JobDefinition } from "../registry-types.ts";
import type { SidekiqItem } from "../sidekiq/item.ts";

export const BULLMQ_PREFIX = "bull";

// Sidekiq's retry option counts retries; BullMQ's attempts counts runs.
const SIDEKIQ_DEFAULT_RETRY = 25;

// Sidekiq's dead set keeps jobs for six months; completed jobs leave no trace in Sidekiq, so a
// short window is kept only for debugging.
const DEAD_JOB_RETENTION_SECONDS = 180 * 24 * 3600;
const COMPLETED_JOB_RETENTION = { age: 3600, count: 1000 };

export function attemptsFor(retry: unknown): number {
  if (retry === false || retry === 0) return 1;
  if (retry === true || retry === undefined || retry === null) return SIDEKIQ_DEFAULT_RETRY + 1;
  if (typeof retry === "number" && Number.isInteger(retry) && retry > 0) return retry + 1;
  throw new Error(`Unsupported Sidekiq retry option ${String(retry)}`);
}

// Sidekiq::JobRetry#delay_for without a sidekiq_retry_in block: count**4 + 15 + rand(10) * (count + 1)
// seconds, where count is the number of retries already made (0 on the first retry).
export function sidekiqBackoffMs(attemptsMade: number, random: () => number = Math.random): number {
  const count = Math.max(attemptsMade - 1, 0);
  return (count ** 4 + 15 + Math.floor(random() * 10) * (count + 1)) * 1000;
}

export const SIDEKIQ_BACKOFF = "sidekiq";

export function bullJobOptions(definition: JobDefinition, item: SidekiqItem, delayMs: number): JobsOptions {
  if (definition.customRetryIn) {
    // The job's sidekiq_retry_in block must be ported alongside it; see README.
    throw new Error(`${String(item.class)} defines sidekiq_retry_in; port its backoff before running it on Node`);
  }
  return {
    jobId: String(item.jid),
    attempts: attemptsFor(item.retry),
    backoff: { type: SIDEKIQ_BACKOFF },
    ...(delayMs > 0 ? { delay: delayMs } : {}),
    removeOnComplete: COMPLETED_JOB_RETENTION,
    removeOnFail: item.retry === false ? true : { age: DEAD_JOB_RETENTION_SECONDS },
  };
}
