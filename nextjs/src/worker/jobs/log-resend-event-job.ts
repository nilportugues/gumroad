// Port of app/sidekiq/log_resend_event_job.rb: a no-op kept so payloads already queued drain
// cleanly after EmailEvent's removal. The reference port for the Node worker.
import type { JobHandler } from "./types.ts";

export const logResendEventJob: JobHandler = async () => {};
