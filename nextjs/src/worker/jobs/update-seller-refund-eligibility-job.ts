// Port of app/sidekiq/update_seller_refund_eligibility_job.rb with User#unpaid_balance_cents,
// enable_refunds! / disable_refunds! and check_for_high_balance_and_remove_low_balance_probation!
// (only its "not on probation" and "below the recovery threshold" exits). Golden:
// __fixtures__/money-jobs.golden.json (scripts/golden/money-jobs.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { findUserBang, isFlagSet, isOnProbation, NotPortedError, setFlag, Users, type UserRecord } from "../../server/models/user.ts";
import { modelJob } from "./support/job-deps.ts";

// LowBalanceProbationRecovery::RECOVERY_THRESHOLD_CENTS
const RECOVERY_THRESHOLD_CENTS = 100_00;
const DISABLE_REFUNDS_BELOW_CENTS = -10_000;

// User#unpaid_balance_cents: balances.unpaid.sum(:amount_cents)
async function unpaidBalanceCents(user: UserRecord): Promise<bigint> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${user.get("id")} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const sum = Object.values(row!)[0];
  return sum == null ? 0n : BigInt((sum as { toString(): string }).toString());
}

export const updateSellerRefundEligibilityJobWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const user = await findUserBang(userId);
  const unpaid = await unpaidBalanceCents(user);

  // LowBalanceProbationRecovery runs from this job only for a seller on probation whose balance
  // has recovered; it is not ported, and must not run after the refunds flag has been written.
  await beforeSideEffects(() => {
    if (isOnProbation(user) && unpaid >= BigInt(RECOVERY_THRESHOLD_CENTS)) throw new NotPortedError("LowBalanceProbationRecovery#recover_automatically!", "app/services/low_balance_probation_recovery.rb");
  });

  const setRefundsDisabled = async (disabled: boolean) => {
    setFlag(user, "refunds_disabled", disabled);
    await Users.saveBang(user, { now: deps.now });
  };
  if (unpaid > 0n && isFlagSet(user, "refunds_disabled")) await setRefundsDisabled(false);
  else if (unpaid < BigInt(DISABLE_REFUNDS_BELOW_CENTS) && !isFlagSet(user, "refunds_disabled")) await setRefundsDisabled(true);

  // check_for_high_balance_and_remove_low_balance_probation!
  if (!isOnProbation(user)) return;
  // Above the threshold the job was handed back before it wrote anything; a balance that recovered
  // since fails the attempt, for the retry to hand back.
  if ((await unpaidBalanceCents(user)) >= BigInt(RECOVERY_THRESHOLD_CENTS)) throw new NotPortedError("LowBalanceProbationRecovery#recover_automatically!", "app/services/low_balance_probation_recovery.rb");
});

export const updateSellerRefundEligibilityJob = updateSellerRefundEligibilityJobWith();
