// Port of ActiveStorage::Blob#purge_later and #analyze_later (activestorage 8.1): ActiveStorage::PurgeJob / AnalyzeJob.perform_later(blob),
// pushed to Sidekiq through ActiveJob's adapter on the queue config/application.rb names for purges (analysis has none: "default").
// Rails runs the job.
import { rawPushToSidekiq } from "../jobs/sidekiq/client.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import { ACTIVE_JOB_WRAPPER, iso8601Nanos, record, serializeArgument } from "../mail/active-job.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";

const PURGE_JOB = "ActiveStorage::PurgeJob";
const ANALYZE_JOB = "ActiveStorage::AnalyzeJob";
// config.active_storage.queues.purge
const PURGE_QUEUE = "low";
const ANALYZE_QUEUE = "default";
const SIDEKIQ_RETRY = 25;

export const purgeBlobLater = (blobId: bigint | number, uuid: () => string) =>
  blobJobLater(PURGE_JOB, PURGE_QUEUE, blobId, uuid);

export const analyzeBlobLater = (blobId: bigint | number, uuid: () => string) =>
  blobJobLater(ANALYZE_JOB, ANALYZE_QUEUE, blobId, uuid);

async function blobJobLater(
  jobClass: string,
  queue: string,
  blobId: bigint | number,
  uuid: () => string,
): Promise<void> {
  const runtime = currentJobsRuntime();
  const now = runtime.now();
  const job: Record<string, JsonValue> = {
    job_class: jobClass,
    job_id: uuid(),
    provider_job_id: null,
    queue_name: queue,
    priority: null,
    arguments: [serializeArgument(record("ActiveStorage::Blob", blobId))],
    executions: 0,
    exception_executions: {},
    locale: "en",
    timezone: "UTC",
    enqueued_at: iso8601Nanos(now),
    scheduled_at: null,
  };
  await rawPushToSidekiq(
    runtime.sidekiqRedis,
    {
      retry: SIDEKIQ_RETRY,
      queue,
      backtrace: true,
      wrapped: jobClass,
      args: [job],
      class: ACTIVE_JOB_WRAPPER,
      jid: runtime.newJid(),
      created_at: new RubyFloat(now),
    },
    now,
  );
}
