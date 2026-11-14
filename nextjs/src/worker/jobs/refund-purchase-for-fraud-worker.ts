// Port of app/sidekiq/refund_purchase_for_fraud_worker.rb up to the refund. `Purchase.find` runs in Node; a purchase that is found is
// refunded (and, for a buyer-fraud run, its buyer blocked), and a missing one is reported to ErrorNotifier before the error is re-raised,
// so both go back to Rails whole. An id Rails casts goes back before any read.
// Golden: __fixtures__/refund-purchase-for-fraud-worker.golden.json (scripts/golden/refund-purchase-for-fraud-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const refundPurchaseForFraudWorkerWith = modelJob({ min: 2, max: 3 }, async ([purchaseId]) => {
  // `Purchase.find(nil)` raises before any statement, and is reported all the same.
  if (purchaseId === null) throw new HandBackToRuby("a missing purchase id is reported to ErrorNotifier");
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  const purchase = await findById("Purchase", id);

  throw new HandBackToRuby(
    purchase === null
      ? "the missing purchase is reported to ErrorNotifier and the error re-raised"
      : "the purchase is refunded for fraud and its buyer may be blocked",
  );
});
export const refundPurchaseForFraudWorker = refundPurchaseForFraudWorkerWith();
