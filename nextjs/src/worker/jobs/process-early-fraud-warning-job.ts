// Port of app/sidekiq/process_early_fraud_warning_job.rb up to `update_from_stripe!`. `EarlyFraudWarning.find` and the `resolved?`
// check run in Node and finish a resolved warning; an unresolved one means a Stripe read and the writes that follow, which hand back
// to Rails before any write, as does an id Rails casts. ProcessPurchaseEarlyFraudWarningJob is a constant alias of this class.
// Golden: __fixtures__/process-early-fraud-warning-job.golden.json (scripts/golden/process-early-fraud-warning-job.rb).
import type { EarlyFraudWarning } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const processEarlyFraudWarningJobWith = modelJob({ min: 1 }, async ([warningId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(warningId, "EarlyFraudWarning.find"));
  const warning = await findByIdBang<EarlyFraudWarning>("EarlyFraudWarning", id);
  if (warning.resolved_at !== null) return;

  throw new HandBackToRuby("an unresolved early fraud warning is refreshed from Stripe");
});
export const processEarlyFraudWarningJob = processEarlyFraudWarningJobWith();
