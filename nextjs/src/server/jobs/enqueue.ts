// Contract owned by WS-05. Enqueues a job by its Ruby class name (`FooJob.perform_async` →
// `enqueue("FooJob", args)`): ported jobs go to BullMQ, the rest to Sidekiq in its wire format.
// Either way the sidekiq-unique-jobs lock is taken in the Sidekiq Redis, so a Node enqueue and a
// Ruby enqueue of the same job deduplicate against each other.
import { bullJobOptions } from "./bullmq/options.ts";
import { JOB_REGISTRY, type JobClass } from "./registry.generated.ts";
import type { JobDefinition, SidekiqOptionValue } from "./registry-types.ts";
import { type JobsRuntime, jobsRuntime } from "./runtime.ts";
import { lockForPush, pushToSidekiq } from "./sidekiq/client.ts";
import { buildSidekiqItem, scheduledAt, type SidekiqItem, takesClientLock } from "./sidekiq/item.ts";
import { dumpRubyJson, type JsonValue } from "./sidekiq/ruby-json.ts";
import { releaseLock } from "./sidekiq/unique-lock.ts";

export type { JobClass } from "./registry.generated.ts";
export type { JsonValue } from "./sidekiq/ruby-json.ts";

export type EnqueueOptions = {
  queue?: string;
  // Absolute time, mirroring `perform_at`; use `delaySeconds` for `perform_in`.
  at?: Date;
  delaySeconds?: number;
  // Other per-call `FooJob.set(...)` options, e.g. a lock that only some callers take.
  set?: Record<string, SidekiqOptionValue>;
};

// The BullMQ job's data: the Sidekiq-shaped item, serialized as Ruby would, so the worker sees
// exactly what a Sidekiq server would (bigints, lock digest) whichever side enqueued it.
// `cron` marks a scheduler template, whose jid is replaced on every fire.
export type BridgedJobData = { sidekiq: string; cron?: boolean };

export function resolveJobClass(
  jobClass: string,
  registry: Readonly<Record<string, JobDefinition>> = JOB_REGISTRY,
): { className: string; definition: JobDefinition } {
  const entry = registry[jobClass];
  if (!entry) throw new Error(`Unknown job class ${jobClass}`);
  if (!entry.aliasOf) return { className: jobClass, definition: entry };
  return resolveJobClass(entry.aliasOf, registry);
}

// Adds a Sidekiq-shaped item to BullMQ. Used by enqueue() and by the bridge that forwards Ruby
// enqueues; the unique lock, if any, is already held.
export async function addToBullmq(runtime: JobsRuntime, definition: JobDefinition, item: SidekiqItem): Promise<void> {
  const now = runtime.now();
  const at = scheduledAt(item);
  const delayMs = at === undefined ? 0 : Math.max(0, Math.round((at - now) * 1000));
  const data: BridgedJobData = { sidekiq: dumpRubyJson(item) };
  await runtime.queue(String(item.queue)).add(String(item.class), data, bullJobOptions(definition, item, delayMs));
}

export async function enqueueWith(runtime: JobsRuntime, jobClass: string, args: JsonValue[], options: EnqueueOptions = {}): Promise<string | null> {
  const { className, definition } = resolveJobClass(jobClass, runtime.registry);
  const now = runtime.now();
  const at = options.at ? options.at.getTime() / 1000 : options.delaySeconds !== undefined ? now + options.delaySeconds : undefined;
  const item = buildSidekiqItem({
    className,
    definition,
    args,
    jid: runtime.newJid(),
    now,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(at === undefined ? {} : { at, scheduled: true }),
    ...(options.set === undefined ? {} : { set: options.set }),
  });

  if (definition.runtime === "ruby") return pushToSidekiq(runtime.sidekiqRedis, item, now);

  if (!(await lockForPush(runtime.sidekiqRedis, item, now))) return null;
  try {
    await addToBullmq(runtime, definition, item);
  } catch (error) {
    // Without this a failed add would hold the digest until its TTL, or forever without one.
    if (takesClientLock(item)) await releaseLock(runtime.sidekiqRedis, item);
    throw error;
  }
  return String(item.jid);
}

// Returns the jid, or null when a unique lock dropped the job, as `perform_async` does.
export async function enqueue(jobClass: JobClass, args: JsonValue[], options: EnqueueOptions = {}): Promise<string | null> {
  return enqueueWith(jobsRuntime(), jobClass, args, options);
}
