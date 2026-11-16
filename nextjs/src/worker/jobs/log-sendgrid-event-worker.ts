// Port of app/sidekiq/log_sendgrid_event_worker.rb: a no-op kept so payloads already queued drain
// cleanly after EmailEvent's removal.
import type { JobHandler } from "./types.ts";

export const logSendgridEventWorker: JobHandler = async () => {};
