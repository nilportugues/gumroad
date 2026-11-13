// Port of app/sidekiq/retry_pending_mandate_charge_job.rb up to Order::ConfirmService. `Order.find_by(id:)` runs in Node and finishes
// an order that does not exist; an order that does means charging held groups through Stripe, which hands back to Rails before any
// write, as does an id Rails casts.
// Golden: __fixtures__/retry-pending-mandate-charge-job.golden.json (scripts/golden/retry-pending-mandate-charge-job.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const retryPendingMandateChargeJobWith = modelJob({ min: 1, max: 2 }, async ([orderId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(orderId, "Order.find_by"));
  if ((await findById("Order", id)) === null) return;

  throw new HandBackToRuby("an order with groups held for a pending mandate is charged through Stripe");
});
export const retryPendingMandateChargeJob = retryPendingMandateChargeJobWith();
