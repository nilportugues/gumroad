// Runs one BullMQ job the way Sidekiq's server middleware chain would, including the
// sidekiq-unique-jobs server half (Lock::UntilExecuted#execute, Lock::UntilExecuting#execute).
import type { Job } from "bullmq";

import type { BridgedJobData } from "../server/jobs/enqueue.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import type { SidekiqItem } from "../server/jobs/sidekiq/item.ts";
import { type JsonValue, parseRubyJson } from "../server/jobs/sidekiq/ruby-json.ts";
import { acquireClientLock, releaseLock } from "../server/jobs/sidekiq/unique-lock.ts";
import { ACTIVE_JOB_WRAPPER } from "../server/mail/active-job.ts";
import { runActiveJob } from "./jobs/active-job.ts";
import type { JobHandler } from "./jobs/types.ts";

// Lock types the Node worker honours. while_executing and until_and_while_executing need the
// server-side runtime lock (the `:RUN` digest), which is not ported yet.
export const SUPPORTED_NODE_LOCKS: ReadonlySet<string | undefined> = new Set([undefined, "until_executed", "until_executing"]);

export function createProcessor(runtime: JobsRuntime, handlers: Record<string, JobHandler>) {
  return async (job: Job<BridgedJobData>): Promise<void> => {
    const item = parseRubyJson(job.data.sidekiq) as SidekiqItem;
    // A scheduler fire is a template; each fire is its own job, as each sidekiq-cron push is.
    if (job.data.cron) item.jid = job.id ?? runtime.newJid();

    if (item.class === ACTIVE_JOB_WRAPPER) return runActiveJob(runtime, item);
    const handler = handlers[String(item.class)];
    if (!handler) throw new Error(`No Node handler for ${String(item.class)}`);
    const run = () => handler(item.args as JsonValue[], { jid: String(item.jid), item, attemptsMade: job.attemptsMade, runtime });
    const lock = typeof item.lock === "string" ? item.lock : undefined;

    switch (lock) {
      case undefined:
        return run();
      case "until_executed": {
        // Locksmith#execute takes the lock if this jid does not already hold it (a retry, or a cron
        // fire), and skips the run when another jid holds it. It unlocks after every attempt.
        if (!(await acquireClientLock(runtime.sidekiqRedis, item, runtime.now()))) {
          console.info(`Skipping ${String(item.class)} ${String(item.jid)}: ${String(item.lock_digest)} is held by another job`);
          return;
        }
        try {
          return await run();
        } finally {
          await releaseLock(runtime.sidekiqRedis, item);
        }
      }
      case "until_executing":
        await releaseLock(runtime.sidekiqRedis, item);
        try {
          return await run();
        } catch (error) {
          await acquireClientLock(runtime.sidekiqRedis, item, runtime.now());
          throw error;
        }
      default:
        throw new Error(`${String(item.class)}: lock ${lock} is not supported on the Node worker yet`);
    }
  };
}
