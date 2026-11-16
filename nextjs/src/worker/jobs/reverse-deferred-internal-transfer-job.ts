// Port of app/sidekiq/reverse_deferred_internal_transfer_job.rb up to `Stripe::Transfer.retrieve`. `Payment.find` and the two early
// returns (no internal transfer, a state that is not failed, returned or cancelled) run in Node; a payment that gets further reads the
// transfer from Stripe, so the job hands back before that call. The exhausted block reads the payment the same way and hands back where
// Ruby reverses the transfer or holds payouts (money): Rails then runs one last attempt and, if it fails, that block itself.
// Golden: __fixtures__/reverse-deferred-internal-transfer-job.golden.json (scripts/golden/reverse-deferred-internal-transfer-job.rb).
import type { Payment } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

const REVERSIBLE_STATES = ["failed", "returned", "cancelled"];

export const reverseDeferredInternalTransferJobWith = modelJob({ min: 1 }, async ([paymentId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(paymentId, "Payment.find"));
  const payment = await findByIdBang<Payment>("Payment", id);
  if (payment.stripe_internal_transfer_id === null) return;
  if (payment.state === null || !REVERSIBLE_STATES.includes(payment.state)) return;

  throw new HandBackToRuby("the internal transfer is read from Stripe");
});
export const reverseDeferredInternalTransferJob = reverseDeferredInternalTransferJobWith();

// `Payment.find_by(id: job["args"].first)`, then `next if payment.nil? || payment.stripe_internal_transfer_id.nil?`.
export const reverseDeferredInternalTransferJobRetriesExhausted: RetriesExhausted = async (msg) => {
  if (!Array.isArray(msg.args)) throw new TypeError("undefined method 'first' for nil");
  const first = msg.args[0];
  const id =
    first === undefined || first === null
      ? null
      : await beforeSideEffects(() => recordIdFrom(first, "Payment.find_by"));
  const payment = await findOneBy<Payment>("Payment", "id", id, true);
  if (payment === null || payment.stripe_internal_transfer_id === null) return;

  throw new HandBackToRuby("the transfer is reversed, or payouts are held, through Stripe");
};
