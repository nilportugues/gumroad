// Port of app/sidekiq/update_seller_refund_eligibility_job.rb with User#unpaid_balance_cents,
// enable_refunds! / disable_refunds! and check_for_high_balance_and_remove_low_balance_probation!
// (its "not on probation" and "below the recovery threshold" exits, and the recovery precheck
// reasons that settle without writing; an account that would be recovered hands back). Golden:
// __fixtures__/money-jobs.golden.json (scripts/golden/money-jobs.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { settledReasonWithoutHistory } from "../../server/models/low-balance-probation-recovery.ts";
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

// LowBalanceProbationRecovery#recover_automatically! returns its precheck without a write for every
// reason that settles before the version history is read; the rest needs the locked transition.
async function requireNoRecoveryWrite(user: UserRecord): Promise<void> {
  if ((await settledReasonWithoutHistory(user)) === null) throw new NotPortedError("LowBalanceProbationRecovery#recover_automatically!", "app/services/low_balance_probation_recovery.rb");
}

export const updateSellerRefundEligibilityJobWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const user = await findUserBang(userId);
  const unpaid = await unpaidBalanceCents(user);

  // Only a recovery that would write is not ported, and it must not run after the refunds flag has been written.
  await beforeSideEffects(async () => {
    if (isOnProbation(user) && unpaid >= BigInt(RECOVERY_THRESHOLD_CENTS)) await requireNoRecoveryWrite(user);
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
  if ((await unpaidBalanceCents(user)) >= BigInt(RECOVERY_THRESHOLD_CENTS)) await requireNoRecoveryWrite(user);
});

export const updateSellerRefundEligibilityJob = updateSellerRefundEligibilityJobWith();
