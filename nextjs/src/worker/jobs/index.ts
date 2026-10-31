// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import { logResendEventJob } from "./log-resend-event-job.ts";
import type { JobHandler } from "./types.ts";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  LogResendEventJob: logResendEventJob,
};
