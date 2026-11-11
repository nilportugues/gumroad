// Port of ActiveStorage::Blob#purge_later (activestorage 8.1): ActiveStorage::PurgeJob.perform_later(blob), pushed to Sidekiq through
// ActiveJob's adapter on the queue config/application.rb names for purges. Rails runs the job.
import { rawPushToSidekiq } from "../jobs/sidekiq/client.ts";
import type { JsonValue } from "../jobs/sidekiq/ruby-json.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import { ACTIVE_JOB_WRAPPER, iso8601Nanos, record, serializeArgument } from "../mail/active-job.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";

const PURGE_JOB = "ActiveStorage::PurgeJob";
// config.active_storage.queues.purge
const PURGE_QUEUE = "low";
const SIDEKIQ_RETRY = 25;

export async function purgeBlobLater(blobId: bigint | number, uuid: () => string): Promise<void> {
  const runtime = currentJobsRuntime();
  const now = runtime.now();
  const job: Record<string, JsonValue> = {
    job_class: PURGE_JOB,
    job_id: uuid(),
    provider_job_id: null,
    queue_name: PURGE_QUEUE,
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
      queue: PURGE_QUEUE,
      backtrace: true,
      wrapped: PURGE_JOB,
      args: [job],
      class: ACTIVE_JOB_WRAPPER,
      jid: runtime.newJid(),
      created_at: new RubyFloat(now),
    },
    now,
  );
}
