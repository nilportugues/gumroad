import type { Redis } from "ioredis";

import type { JobsChannel, RawJob } from "./channels";

// The jobs a Node route enqueued, as the recorder wrote them for an example tagged `parity_mail_jobs: true` (or any ActiveJob that went
// through the Sidekiq adapter): the wrapped job's class, arguments and queue with `activeJob: true`, so a mail enqueue (`deliver_later`)
// is compared like any other job instead of being dropped from the comparison.
export const JOB_WRAPPER = "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper";

type SidekiqItem = { class: string; args: unknown[]; queue: string; at?: number };

export function unwrapActiveJob(item: RawJob): RawJob {
  const wrapped = item.args[0] as { job_class?: string; arguments?: unknown[]; queue_name?: string } | undefined;
  if (item.class !== JOB_WRAPPER || !wrapped?.job_class) return item;
  return {
    ...item,
    class: wrapped.job_class,
    args: wrapped.arguments ?? [],
    queue: wrapped.queue_name ?? item.queue,
    activeJob: true,
  };
}

const rawJob = (item: SidekiqItem): RawJob => ({
  class: item.class,
  args: item.args,
  queue: item.queue,
  ...(item.at === undefined ? {} : { at: item.at }),
});

export const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// Every job Node left behind: BullMQ jobs wrapping a Sidekiq item, then the items of a job whose body is still Ruby, which go straight
// to Sidekiq's `queue:*` lists or its `schedule`. Sorted, because Rails and Node push in different orders across the stores.
export async function drainRedisJobs(redis: Redis, ignored: ReadonlySet<string> = new Set()): Promise<RawJob[]> {
  const items: SidekiqItem[] = [];
  for (const key of await redis.keys("bull:*")) {
    if ((await redis.type(key)) !== "hash") continue;
    const data = await redis.hget(key, "data");
    if (data === null) continue;
    items.push(JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as SidekiqItem);
  }
  for (const key of await redis.keys("queue:*"))
    for (const raw of await redis.lrange(key, 0, -1)) items.push(JSON.parse(raw) as SidekiqItem);
  for (const raw of await redis.zrange("schedule", "0", "-1")) items.push(JSON.parse(raw) as SidekiqItem);
  return items
    .map((item) => unwrapActiveJob(rawJob(item)))
    .filter((job) => !ignored.has(job.class))
    .sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
}

export function redisJobsChannel(redis: Redis, ignored: ReadonlySet<string> = new Set()): JobsChannel {
  return {
    async reset() {
      /* the seeder flushes the database */
    },
    drain: () => drainRedisJobs(redis, ignored),
  };
}
