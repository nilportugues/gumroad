// Runs one BullMQ job the way Sidekiq's server middleware chain would, including the
// sidekiq-unique-jobs 8.0.10 server half (`Lock::<Type>#execute` for every lock type).
// __fixtures__/server-locks.golden.json pins the runtime locks against the real gem.
import type { Job } from "bullmq";

import { type BridgedJobData, enqueueWith, resolveJobClass } from "../server/jobs/enqueue.ts";
import { HandBackToRuby } from "../server/jobs/hand-back.ts";
import type { JobDefinition } from "../server/jobs/registry-types.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import { prepareServerItem, runtimeLockDigest, type SidekiqItem, serverLockType } from "../server/jobs/sidekiq/item.ts";
import { rawPushToSidekiq } from "../server/jobs/sidekiq/client.ts";
import { type JsonValue, parseRubyJson, RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import { executeLocked, relock, releaseLock } from "../server/jobs/sidekiq/unique-lock.ts";
import { ACTIVE_JOB_WRAPPER } from "../server/mail/active-job.ts";
import { SIDEKIQ_EXECUTOR, withExecutor } from "../server/models/runtime/query-cache.ts";
import { runActiveJob } from "./jobs/active-job.ts";
import type { JobHandler } from "./jobs/types.ts";
import { handleFailure, type RetryHooks } from "./retry.ts";

export const SUPPORTED_NODE_LOCKS: ReadonlySet<string | undefined> = new Set([
  undefined,
  "until_executed",
  "until_executing",
  "while_executing",
  "until_and_while_executing",
]);

// SidekiqUniqueJobs::Conflict, raised by the server `raise` strategy.
export class UniqueJobsConflict extends Error {
  constructor(item: SidekiqItem) {
    super(`Item with the key: ${String(item.lock_digest)} is already scheduled or processing`);
    this.name = "SidekiqUniqueJobs::Conflict";
  }
}

type ServerStrategy = (runtime: JobsRuntime, item: SidekiqItem, definition: JobDefinition) => Promise<void>;

// OnConflict strategies a runtime lock can hit on the server. `replace` and `reject` are not
// used by any job and are refused at worker start rather than approximated.
const SERVER_STRATEGIES: Record<string, ServerStrategy> = {
  none: async () => {},
  log: async (_runtime, item) => {
    console.info(`Skipping job with id (${String(item.jid)}) because lock_digest: (${String(item.lock_digest)}) already exists`);
  },
  raise: async (_runtime, item) => {
    throw new UniqueJobsConflict(item);
  },
  // `job_class.set(queue: item["queue"].to_sym).perform_in(schedule_in, *item["args"])`.
  reschedule: async (runtime, item, definition) => {
    const scheduleIn = definition.options.schedule_in;
    await enqueueWith(runtime, String(item.class), item.args as JsonValue[], {
      queue: String(item.queue),
      delaySeconds: typeof scheduleIn === "number" ? scheduleIn : 5,
    });
  },
};

// LockConfig#on_server_conflict over OnConflict.find_strategy (nil and unknown names fall back
// to the null strategy).
export function serverStrategyName(onConflict: JsonValue | undefined): string {
  let name: JsonValue | undefined = onConflict;
  if (onConflict && typeof onConflict === "object" && !Array.isArray(onConflict) && !(onConflict instanceof RubyFloat)) {
    name = (onConflict as Record<string, JsonValue>).server;
  }
  return typeof name === "string" && name !== "" ? name : "none";
}

// Why a job's lock cannot run on the Node worker, or undefined when it can.
export function unsupportedLock(definition: JobDefinition): string | undefined {
  const lock = typeof definition.options.lock === "string" ? definition.options.lock : undefined;
  if (!SUPPORTED_NODE_LOCKS.has(lock)) return `uses lock ${String(lock)}, not supported on Node`;
  if (lock !== "while_executing" && lock !== "until_and_while_executing") return undefined;
  const strategy = serverStrategyName(definition.options.on_conflict as JsonValue | undefined);
  const known = ["none", "log", "raise", "reschedule", "replace", "reject"];
  if (known.includes(strategy) && !(strategy in SERVER_STRATEGIES)) return `uses server on_conflict ${strategy}, not ported`;
  return undefined;
}

async function onServerConflict(runtime: JobsRuntime, item: SidekiqItem, definition: JobDefinition): Promise<void> {
  const strategy = SERVER_STRATEGIES[serverStrategyName(item.on_conflict)] ?? SERVER_STRATEGIES.none!;
  await strategy(runtime, item, definition);
}

const NO_HOOKS: RetryHooks = { retryIn: {}, retriesExhausted: {} };

export function createProcessor(runtime: JobsRuntime, handlers: Record<string, JobHandler>, hooks: RetryHooks = NO_HOOKS) {
  const runJob = createLockedRun(runtime, handlers);
  return async (job: Job<BridgedJobData>): Promise<void> => {
    const fetched = parseRubyJson(job.data.sidekiq) as SidekiqItem;
    // A scheduler fire is a template; each fire is its own job, as each sidekiq-cron push is.
    if (job.data.cron) fetched.jid = job.id ?? runtime.newJid();
    // Sidekiq::Rails::Reloader runs JobRetry#local, the server middleware and the job inside the
    // Rails executor, which turns the query cache on; JobRetry#global stays outside it.
    // ActiveJob keeps its own retry semantics (runActiveJob); JobRetry below is Sidekiq::Job's.
    if (fetched.class === ACTIVE_JOB_WRAPPER) return withExecutor(() => runActiveJob(runtime, fetched), SIDEKIQ_EXECUTOR);
    try {
      await withExecutor(() => runJob(job, fetched), SIDEKIQ_EXECUTOR);
    } catch (error) {
      // The lock handling above already left the lock as a failed attempt would, which is the
      // state Sidekiq's server middleware expects to pick up from.
      if (error instanceof HandBackToRuby) return handBack(runtime, fetched, error);
      // JobRetry#local wraps the server middleware, so the lock is already released here.
      const { definition } = resolveJobClass(String(fetched.class), runtime.registry);
      throw await handleFailure(error, { item: fetched, definition, attemptsMade: job.attemptsMade, runtime, hooks });
    }
  };
}

// Straight onto the queue, as the job was due when Node fetched it; `at` would park it in the
// schedule set until the poller's next pass.
async function handBack(runtime: JobsRuntime, fetched: SidekiqItem, error: HandBackToRuby): Promise<void> {
  const { at: _at, ...item } = fetched;
  await rawPushToSidekiq(runtime.sidekiqRedis, item, runtime.now());
  console.info(`${String(fetched.class)} ${String(fetched.jid)}: ${error.message}`);
}

function createLockedRun(runtime: JobsRuntime, handlers: Record<string, JobHandler>) {
  return async (job: Job<BridgedJobData>, fetched: SidekiqItem): Promise<void> => {
    const handler = handlers[String(fetched.class)];
    if (!handler) throw new Error(`No Node handler for ${String(fetched.class)}`);
    const { definition } = resolveJobClass(String(fetched.class), runtime.registry);
    const lock = serverLockType(fetched, definition);
    const item = lock === undefined ? fetched : prepareServerItem(fetched, definition);
    const redis = runtime.sidekiqRedis;
    const now = () => runtime.now();
    const run = async (context: SidekiqItem = item) => {
      await handler(context.args as JsonValue[], { jid: String(context.jid), item: context, attemptsMade: job.attemptsMade, runtime });
    };

    switch (lock) {
      case undefined:
        return run();
      case "until_executed": {
        // Locksmith#execute takes the lock if this jid does not already hold it (a retry, or a cron
        // fire), and skips the run when another jid holds it. It unlocks after every attempt.
        if (!(await executeLocked(redis, item, now, run))) {
          console.info(`Skipping ${String(item.class)} ${String(item.jid)}: ${String(item.lock_digest)} is held by another job`);
        }
        return;
      }
      case "until_executing":
        await releaseLock(redis, item, now());
        try {
          return await run();
        } catch (error) {
          await relock(redis, item, now(), 1);
          throw error;
        }
      case "while_executing": {
        // Lock::WhileExecuting: the client took no lock; the run holds `<digest>:RUN`.
        const runtimeItem = { ...item, lock_digest: runtimeLockDigest(String(item.lock_digest)) };
        if (!(await executeLocked(redis, runtimeItem, now, () => run(runtimeItem)))) await onServerConflict(runtime, runtimeItem, definition);
        return;
      }
      case "until_and_while_executing": {
        // Lock::UntilAndWhileExecuting: trade the client lock for the runtime one. Any exception,
        // including a `raise` conflict, takes the client lock back before propagating.
        try {
          if (!(await releaseLock(redis, item, now()))) {
            console.info(`Skipping ${String(item.class)} ${String(item.jid)}: it no longer holds ${String(item.lock_digest)}`);
            return;
          }
          const runtimeItem = { ...item, lock_digest: runtimeLockDigest(String(item.lock_digest)) };
          if (!(await executeLocked(redis, runtimeItem, now, () => run()))) await onServerConflict(runtime, runtimeItem, definition);
          return;
        } catch (error) {
          await relock(redis, item, now(), 2);
          throw error;
        }
      }
      default:
        throw new Error(`${String(item.class)}: lock ${lock} is not supported on the Node worker`);
    }
  };
}
