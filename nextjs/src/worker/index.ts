// The BullMQ worker process: `node src/worker/index.ts [--queues critical,default,low,exports]`.
// Mirrors docker/web/sidekiq_worker.sh: one process for critical/default/low/exports and a
// separate one for `--queues long`. BullMQ has no strict cross-queue order, so each queue gets
// its own concurrency (WORKER_CONCURRENCY_<QUEUE>) instead of Sidekiq's strict priority.
import { Worker } from "bullmq";
import type { Redis } from "ioredis";

import { BULLMQ_PREFIX, SIDEKIQ_BACKOFF, sidekiqBackoffMs } from "../server/jobs/bullmq/options.ts";
import { getConfig } from "../server/infra/config.ts";
import { PORTED_JOBS } from "../server/jobs/ported-jobs.ts";
import { resolveJobClass } from "../server/jobs/enqueue.ts";
import { bullmqRedisUrl, createRedis, sidekiqRedisUrl } from "../server/jobs/redis.ts";
import { createJobsRuntime, type JobsRuntime } from "../server/jobs/runtime.ts";
import { runBridge } from "./bridge.ts";
import { syncCronSchedulers } from "./cron.ts";
import { JOB_HANDLERS } from "./jobs/index.ts";
import type { JobHandler } from "./jobs/types.ts";
import { createProcessor, SUPPORTED_NODE_LOCKS } from "./processor.ts";

const DEFAULT_QUEUES = ["critical", "default", "low", "exports"];
const DEFAULT_CONCURRENCY = 5;

export function validatePortedJobs(ported: readonly string[], handlers: Record<string, JobHandler>): void {
  const problems: string[] = [];
  for (const name of ported) {
    const { definition } = resolveJobClass(name);
    if (definition.runtime !== "node") problems.push(`${name} is not marked runtime: node; run npm run jobs:generate`);
    if (!handlers[name]) problems.push(`${name} has no handler in src/worker/jobs`);
    const lock = definition.options.lock;
    if (!SUPPORTED_NODE_LOCKS.has(typeof lock === "string" ? lock : undefined)) problems.push(`${name} uses lock ${String(lock)}, not supported on Node yet`);
    if (definition.customRetryIn) problems.push(`${name} defines sidekiq_retry_in; port its backoff first`);
  }
  for (const name of Object.keys(handlers)) if (!ported.includes(name)) problems.push(`handler ${name} is not listed in ported-jobs.ts`);
  if (problems.length) throw new Error(`Cannot start the worker:\n  ${problems.join("\n  ")}`);
}

export type StartedWorker = { workers: Worker[]; stop(): Promise<void> };

export async function startWorker(options: {
  runtime: JobsRuntime;
  queues: readonly string[];
  handlers?: Record<string, JobHandler>;
  bridge?: boolean;
  prefix?: string;
}): Promise<StartedWorker> {
  const { runtime, queues } = options;
  const handlers = options.handlers ?? JOB_HANDLERS;
  const processor = createProcessor(runtime, handlers);
  const connections: Redis[] = [];
  const track = (connection: Redis) => (connections.push(connection), connection);
  const workers = queues.map(
    (queue) =>
      new Worker(queue, processor, {
        // BullMQ only closes connections it created itself.
        connection: track(runtime.bullmqRedis.duplicate()),
        prefix: options.prefix ?? BULLMQ_PREFIX,
        concurrency: Number(getConfig(`WORKER_CONCURRENCY_${queue.toUpperCase()}`) ?? DEFAULT_CONCURRENCY),
        settings: {
          backoffStrategy: (attemptsMade, type) => {
            if (type !== SIDEKIQ_BACKOFF) throw new Error(`Unknown backoff ${String(type)}`);
            return sidekiqBackoffMs(attemptsMade);
          },
        },
      }),
  );
  await syncCronSchedulers(runtime, queues);

  const abort = new AbortController();
  const bridgeRedis = options.bridge ? runtime.sidekiqRedis.duplicate() : undefined;
  const bridge = bridgeRedis ? runBridge(runtime, bridgeRedis, abort.signal) : Promise.resolve();

  return {
    workers,
    async stop() {
      abort.abort();
      await Promise.all(workers.map((worker) => worker.close()));
      for (const connection of connections) connection.disconnect();
      await bridge;
      bridgeRedis?.disconnect();
    },
  };
}

if (import.meta.main) {
  const queuesFlag = process.argv.indexOf("--queues");
  const queues = queuesFlag === -1 ? DEFAULT_QUEUES : (process.argv[queuesFlag + 1] ?? "").split(",").filter(Boolean);
  validatePortedJobs(PORTED_JOBS, JOB_HANDLERS);
  const runtime = createJobsRuntime({ sidekiqRedis: createRedis(sidekiqRedisUrl()), bullmqRedis: createRedis(bullmqRedisUrl()) });
  // One bridge consumer per process is enough; the `long` process leaves it to the main one.
  const started = await startWorker({ runtime, queues, bridge: !queues.includes("long") });
  console.info(`Worker running on ${queues.join(", ")}`);
  const shutdown = async () => {
    await started.stop();
    await runtime.close();
    runtime.sidekiqRedis.disconnect();
    runtime.bullmqRedis.disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
