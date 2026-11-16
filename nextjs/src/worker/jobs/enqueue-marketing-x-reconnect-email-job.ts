// Port of app/sidekiq/enqueue_marketing_x_reconnect_email_job.rb. A held delivery lock throws
// UniqueJobConflictError, as SidekiqUniqueJobs::Conflict does in Ruby, so this job retries.
import { enqueueWith } from "../../server/jobs/enqueue.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

export const enqueueMarketingXReconnectEmailJob: JobHandler = async (args, { runtime }) => {
  checkArity(args, 1);
  await enqueueWith(runtime, "SendMarketingXReconnectEmailJob", [args[0]!], { set: { on_conflict: { client: "raise" } } });
};
