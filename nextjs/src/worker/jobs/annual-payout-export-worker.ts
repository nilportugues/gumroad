// Port of app/sidekiq/annual_payout_export_worker.rb up to `WithMaxExecutionTime.timeout_queries`. `User.find` runs in Node. Everything
// after it sits inside the query cap (a session `set max_execution_time` on both connections, which a pooled Node connection cannot
// hold) and ends in a CSV attachment and a mail, so a user that is found goes back to Rails before the payments scan. An id Rails casts
// goes back before any read.
// Golden: __fixtures__/annual-payout-export-worker.golden.json (scripts/golden/annual-payout-export-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const annualPayoutExportWorkerWith = modelJob({ min: 2, max: 3 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang("User", id);

  throw new HandBackToRuby("the annual payout CSV is built under the query cap, attached and mailed");
});
export const annualPayoutExportWorker = annualPayoutExportWorkerWith();
