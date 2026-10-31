// Port of app/sidekiq/sync_stripe_business_profile_url_worker.rb: the old class name, kept for
// payloads still queued under it, forwarding to SyncStripeBusinessProfileUrlJob.
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

export const syncStripeBusinessProfileUrlWorker: JobHandler = async (args, { runtime }) => {
  checkArity(args, 1, 2);
  await enqueueWith(runtime, "SyncStripeBusinessProfileUrlJob", [args[0]!]);
};
