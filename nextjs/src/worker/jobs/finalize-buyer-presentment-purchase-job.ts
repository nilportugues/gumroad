// Port of app/sidekiq/finalize_buyer_presentment_purchase_job.rb up to `pending_buyer_presentment_settlement?`. `Purchase.find` runs in
// Node and finishes a purchase that is not in progress (`pending_processor_settlement?` starts with `in_progress?`). An in-progress
// purchase means the settlement checks and the Stripe sync, which hand back to Rails before any read beyond the purchase, as does an id
// Rails casts. Golden: __fixtures__/finalize-buyer-presentment-purchase-job.golden.json
// (scripts/golden/finalize-buyer-presentment-purchase-job.rb).
import type { Purchase } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

const IN_PROGRESS = "in_progress";

export const finalizeBuyerPresentmentPurchaseJobWith = modelJob({ min: 1, max: 2 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = await findByIdBang<Purchase>("Purchase", id);
  if (purchase.purchase_state !== IN_PROGRESS) return;

  throw new HandBackToRuby("an in-progress purchase is checked for settlement data and synced with Stripe");
});
export const finalizeBuyerPresentmentPurchaseJob = finalizeBuyerPresentmentPurchaseJobWith();
