// Port of the nothing-to-do path of app/sidekiq/update_purchase_email_to_match_account_worker.rb: a missing user raises
// RecordNotFound and a user with no purchases finishes after the first `find_each` batch. A purchase is rewritten with
// `Purchase#update!`, whose validations and callbacks are not ported, so the job is handed back as soon as the batch has a row.
// Golden: __fixtures__/update-purchase-email-to-match-account-worker.golden.json
// (scripts/golden/update-purchase-email-to-match-account-worker.rb).
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { purchasesOfPurchaserFirstBatch } from "../../server/models/purchase.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const updatePurchaseEmailToMatchAccountWorkerWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  const user = await findByIdBang<User>("User", id);

  if ((await purchasesOfPurchaserFirstBatch(user.id)).length > 0) {
    throw new HandBackToRuby("Purchase#update! of a user's purchases is not ported");
  }
});

export const updatePurchaseEmailToMatchAccountWorker = updatePurchaseEmailToMatchAccountWorkerWith();
