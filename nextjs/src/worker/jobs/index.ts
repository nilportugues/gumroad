// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";
import { logResendEventJob } from "./log-resend-event-job.ts";
import { logSendgridEventWorker } from "./log-sendgrid-event-worker.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import type { JobHandler } from "./types.ts";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  EnqueueMarketingXReconnectEmailJob: enqueueMarketingXReconnectEmailJob,
  HandleSnsAwsConfigEventWorker: handleSnsAwsConfigEventWorker,
  LogResendEventJob: logResendEventJob,
  LogSendgridEventWorker: logSendgridEventWorker,
  SyncStripeBusinessProfileUrlWorker: syncStripeBusinessProfileUrlWorker,
  UpdateCurrenciesWorker: updateCurrenciesWorker,
};
