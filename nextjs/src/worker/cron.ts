// sidekiq-cron entries whose class runs on Node become BullMQ job schedulers. Ruby must stop
// loading those entries at the same deploy (see src/server/jobs/README.md), or both fire.
import { attemptsFor, SIDEKIQ_BACKOFF } from "../server/jobs/bullmq/options.ts";
import { resolveJobClass } from "../server/jobs/enqueue.ts";
import { CRON_SCHEDULE } from "../server/jobs/registry.generated.ts";
import type { CronDefinition, JobDefinition } from "../server/jobs/registry-types.ts";
import type { JobsRuntime } from "../server/jobs/runtime.ts";
import { buildSidekiqItem } from "../server/jobs/sidekiq/item.ts";
import { dumpRubyJson, type JsonValue } from "../server/jobs/sidekiq/ruby-json.ts";

export function nodeOwnedCronEntries(schedule: readonly CronDefinition[] = CRON_SCHEDULE, registry?: Readonly<Record<string, JobDefinition>>): CronDefinition[] {
  return schedule.filter((entry) => resolveJobClass(entry.class, registry).definition.runtime === "node");
}

// Upserts a scheduler per Node-owned entry on the given queues and removes schedulers whose
// entry is gone or back on Ruby. The scheduler id is the sidekiq_schedule.yml key. sidekiq-cron
// takes the unique lock when it pushes each fire; a scheduler has no push step, so the processor
// takes it when the fire starts (Locksmith#execute does the same for until_executed).
export async function syncCronSchedulers(runtime: JobsRuntime, queueNames: readonly string[], schedule: readonly CronDefinition[] = CRON_SCHEDULE) {
  const desired = new Set<string>();
  for (const entry of nodeOwnedCronEntries(schedule, runtime.registry)) {
    const { className, definition } = resolveJobClass(entry.class, runtime.registry);
    const item = buildSidekiqItem({
      className,
      definition,
      args: (entry.args ?? []) as JsonValue[],
      jid: "replaced-per-fire",
      now: runtime.now(),
      ...(entry.queue === undefined ? {} : { queue: entry.queue }),
    });
    if (!queueNames.includes(String(item.queue))) continue;
    desired.add(entry.name);
    await runtime
      .queue(String(item.queue))
      .upsertJobScheduler(
        entry.name,
        { pattern: entry.cron, tz: "UTC" },
        { name: className, data: { sidekiq: dumpRubyJson(item), cron: true }, opts: { attempts: attemptsFor(item.retry), backoff: { type: SIDEKIQ_BACKOFF } } },
      );
  }
  for (const queueName of queueNames) {
    for (const scheduler of await runtime.queue(queueName).getJobSchedulers()) {
      if (!desired.has(scheduler.key)) await runtime.queue(queueName).removeJobScheduler(scheduler.key);
    }
  }
}
