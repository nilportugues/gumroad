// Port of app/sidekiq/finalize_buyer_presentment_charge_job.rb up to `charge.purchases`. `Charge.find` and
// `Charge#settlement_deferrable?` run in Node and finish a charge that does not defer settlement; a deferrable one means reading its
// purchases and syncing them with Stripe, which hands back to Rails before any write, as does an id Rails casts.
// Golden: __fixtures__/finalize-buyer-presentment-charge-job.golden.json (scripts/golden/finalize-buyer-presentment-charge-job.rb).
import type { Charge } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

// charge_presentment.present? || merchant_account&.user_id.present? || merchant_account.nil?
async function settlementDeferrable(charge: Charge): Promise<boolean> {
  if ((await findOneBy("ChargePresentment", "charge_id", charge.id)) !== null) return true;
  const account = await findById<{ user_id: bigint | null }>("MerchantAccount", charge.merchant_account_id);
  return account === null || account.user_id !== null;
}

export const finalizeBuyerPresentmentChargeJobWith = modelJob({ min: 1, max: 2 }, async ([chargeId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(chargeId, "Charge.find"));
  const charge = await findByIdBang<Charge>("Charge", id);
  if (!(await settlementDeferrable(charge))) return;

  throw new HandBackToRuby("a charge that defers settlement is finalized from its purchases and Stripe");
});
export const finalizeBuyerPresentmentChargeJob = finalizeBuyerPresentmentChargeJobWith();
