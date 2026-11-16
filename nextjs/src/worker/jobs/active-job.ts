// ActiveJob classes run through Sidekiq's JobWrapper, so they are keyed by the job_class inside the
// payload rather than by the registry's Sidekiq class. Only MailDeliveryJob has a Node body; any
// other wrapper item is pushed back to Sidekiq unchanged.
import type { JobsRuntime } from "../../server/jobs/runtime.ts";
import { rawPushToSidekiq } from "../../server/jobs/sidekiq/client.ts";
import type { SidekiqItem } from "../../server/jobs/sidekiq/item.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { MAIL_DELIVERY_JOB } from "../../server/mail/active-job.ts";
import { performMailDelivery } from "../../server/mail/delivery.ts";

export async function runActiveJob(runtime: JobsRuntime, item: SidekiqItem): Promise<void> {
  const job = (item.args as Record<string, JsonValue>[])[0];
  if (job?.job_class === MAIL_DELIVERY_JOB) return performMailDelivery(runtime, item);
  return rawPushToSidekiq(runtime.sidekiqRedis, item, runtime.now());
}
