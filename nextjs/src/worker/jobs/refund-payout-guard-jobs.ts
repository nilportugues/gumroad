// The guards of four jobs whose work is a refund, a processor call, a payout or a payout-period aggregate:
//   app/sidekiq/refund_purchase_worker.rb              (a purchase that does not exist)
//   app/sidekiq/fight_dispute_job.rb                   (no evidence, resolved evidence, a window still open)
//   app/sidekiq/payout_users_worker.rb                 (nobody to pay; the rest runs in models/payout-users-service.ts)
//   app/sidekiq/update_user_balance_stats_cache_worker.rb (a user that does not exist)
// Everything past a guard is handed back to Rails before the job's first write: refunds go through Refund's callbacks
// and the charge processors, a dispute's evidence is forwarded to Stripe, payments are created per user and the
// stats cache is made of the payout-period aggregates of PayoutsHelper (see models/user-balance-stats.ts).
// Golden: __fixtures__/refund-payout-guard-jobs.golden.json (scripts/golden/refund-payout-guard-jobs.rb).
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { processPayoutUsers } from "../../server/models/payout-users-service.ts";
import { PAYOUT_TYPE_STANDARD } from "../../server/models/payouts.ts";
import { findPurchaseBang } from "../../server/models/purchase.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

// `Refund::FRAUD` takes the fraud path; any other reason is stored on the refund. Both refund through the processor.
export const refundPurchaseWorkerWith = modelJob({ min: 2, max: 3 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  await findPurchaseBang(id);
  await beforeSideEffects(() => {
    throw new NotPortedError(
      "Purchase#refund_and_save! / #refund_for_fraud_and_block_buyer!",
      "refund_purchase_worker.rb (charge processor refund)",
    );
  });
});
export const refundPurchaseWorker = refundPurchaseWorkerWith();

// FightDisputeJob moved to fight-dispute-job.ts; its guards stay in this golden.
export { fightDisputeJob, fightDisputeJobWith } from "./fight-dispute-job.ts";

// `Array.wrap(user_ids)`: nil is nobody, an Integer is one user. With nobody there is nothing to create or process.
export const payoutUsersWorkerWith = modelJob(
  { min: 3, max: 5 },
  async ([dateString, processorType, userIds, payoutType, retrying], deps) => {
    if (userIds === null || (Array.isArray(userIds) && userIds.length === 0)) return;
    await beforeSideEffects(() =>
      processPayoutUsers(
        {
          dateString,
          processorType,
          userIds,
          payoutType: payoutType ?? PAYOUT_TYPE_STANDARD,
          retrying: retrying ?? false,
        },
        { now: deps.now },
      ),
    );
  },
);
export const payoutUsersWorker = payoutUsersWorkerWith();

export const updateUserBalanceStatsCacheWorkerWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang("User", id);
  await beforeSideEffects(() => {
    throw new NotPortedError(
      "UserBalanceStatsService#write_cache",
      "user_balance_stats_service.rb (PayoutsHelper#payout_period_data)",
    );
  });
});
export const updateUserBalanceStatsCacheWorker = updateUserBalanceStatsCacheWorkerWith();
