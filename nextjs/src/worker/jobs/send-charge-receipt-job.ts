// Port of app/sidekiq/send_charge_receipt_job.rb up to `charge.purchases`. `Charge.find` and the `receipt_sent?` check run in Node and
// finish a charge whose receipt went out; anything else means reading purchases, stamping and mail, which hands back to Rails before
// any write, as does an id Rails casts.
// Golden: __fixtures__/send-charge-receipt-job.golden.json (scripts/golden/send-charge-receipt-job.rb).
import type { Charge } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

// Charge `has_flags 1 => :receipt_sent`
const RECEIPT_SENT = 1n;

export const sendChargeReceiptJobWith = modelJob({ min: 1, max: 2 }, async ([chargeId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(chargeId, "Charge.find"));
  const charge = await findByIdBang<Charge>("Charge", id);
  if ((BigInt(charge.flags) & RECEIPT_SENT) !== 0n) return;

  throw new HandBackToRuby("a receipt that is not sent yet is stamped and mailed");
});
export const sendChargeReceiptJob = sendChargeReceiptJobWith();
