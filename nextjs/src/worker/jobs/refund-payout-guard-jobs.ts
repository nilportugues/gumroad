// The guards of four jobs whose work is a refund, a processor call, a payout or a payout-period aggregate:
//   app/sidekiq/refund_purchase_worker.rb              (a purchase that does not exist)
//   app/sidekiq/fight_dispute_job.rb                   (no evidence, resolved evidence, a window still open)
//   app/sidekiq/payout_users_worker.rb                 (nobody to pay)
//   app/sidekiq/update_user_balance_stats_cache_worker.rb (a user that does not exist)
// Everything past a guard is handed back to Rails before the job's first write: refunds go through Refund's callbacks
// and the charge processors, a dispute's evidence is forwarded to Stripe, payments are created per user and the
// stats cache is made of the payout-period aggregates of PayoutsHelper (see models/user-balance-stats.ts).
// Golden: __fixtures__/refund-payout-guard-jobs.golden.json (scripts/golden/refund-payout-guard-jobs.rb).
import type { Dispute, DisputeEvidence } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { DISPUTE_EVIDENCES, windowOpen } from "../../server/models/dispute-evidence.ts";
import { findPurchaseBang } from "../../server/models/purchase.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { modelJob } from "./support/job-deps.ts";

// `Refund::FRAUD` takes the fraud path; any other reason is stored on the refund. Both refund through the processor.
export const refundPurchaseWorkerWith = modelJob({ min: 2, max: 3 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  await findPurchaseBang(id);
  await beforeSideEffects(() => {
    throw new NotPortedError("Purchase#refund_and_save! / #refund_for_fraud_and_block_buyer!", "refund_purchase_worker.rb (charge processor refund)");
  });
});
export const refundPurchaseWorker = refundPurchaseWorkerWith();

export const fightDisputeJobWith = modelJob({ min: 1 }, async ([disputeId], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(disputeId, "Dispute.find"));
  const dispute = await findByIdBang<Dispute>("Dispute", id);
  const evidence = await findOneBy<DisputeEvidence>("DisputeEvidence", "dispute_id", dispute.id, true);
  if (evidence === null) throw new TypeError("undefined method 'resolved?' for nil");
  if (evidence.resolved_at !== null) return;
  // Exact comparison against the deadline: nothing is forwarded before the window closes.
  if (windowOpen(evidence.seller_contacted_at, deps.now())) return;
  await beforeSideEffects(() => {
    throw new NotPortedError(`${DISPUTE_EVIDENCES}.update_as_resolved!`, "fight_dispute_job.rb (evidence submission to the charge processor)");
  });
});
export const fightDisputeJob = fightDisputeJobWith();

// `Array.wrap(user_ids)`: nil is nobody, an Integer is one user. With nobody there is nothing to create or process.
export const payoutUsersWorkerWith = modelJob({ min: 3, max: 5 }, async ([, , userIds]) => {
  if (userIds === null || (Array.isArray(userIds) && userIds.length === 0)) return;
  await beforeSideEffects(() => {
    throw new NotPortedError("PayoutUsersService#create_payments", "payout_users_service.rb (Payouts.create_payments and the payout processors)");
  });
});
export const payoutUsersWorker = payoutUsersWorkerWith();

export const updateUserBalanceStatsCacheWorkerWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang("User", id);
  await beforeSideEffects(() => {
    throw new NotPortedError("UserBalanceStatsService#write_cache", "user_balance_stats_service.rb (PayoutsHelper#payout_period_data)");
  });
});
export const updateUserBalanceStatsCacheWorker = updateUserBalanceStatsCacheWorkerWith();
