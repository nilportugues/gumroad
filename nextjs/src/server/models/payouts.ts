// Port of Payouts.create_payments (app/business/payments/payouts/payouts.rb) for the Stripe processor, one slice at a time. This
// slice: `mark_balances_processing` up to the claim. Golden: scripts/golden/payouts-create-payments.rb.
//
// Refused with NotPortedError before any write, from what the lock and the reads already returned: a seller whose payouts a
// chargeback-rate hold may pay at 75% (the reserve), and everything payout-reads.ts refuses.
import {
  minimumPayoutAmountCents,
  payableBalancesForProcessor,
  unpaidBalancesUpTo,
  type HeldBalance,
} from "./payout-reads.ts";
import { isFlagSet, jsonDataForAttr, NotPortedError, Users, type UserRecord } from "./user.ts";

export const PAYOUT_TYPE_STANDARD = "standard";
export const PAYOUT_TYPE_INSTANT = "instant";
// StripePayoutProcessor::MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS
export const MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS = 1_00;
const PAYOUT_PAUSE_SOURCE_SYSTEM = "system";

export type PayoutType = typeof PAYOUT_TYPE_STANDARD | typeof PAYOUT_TYPE_INSTANT;
export type Claim = { balances: HeldBalance[]; underReserve: boolean };

// `payout_minimum_cents`
export const payoutMinimumCents = (user: UserRecord, payoutType: PayoutType) =>
  payoutType === PAYOUT_TYPE_INSTANT
    ? Promise.resolve(MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS)
    : minimumPayoutAmountCents(user);

// `under_chargeback_rate_reserve?` is true only for a seller paused by the system; whether that pause is the chargeback-rate hold
// is read from a comment, so such a seller is refused instead.
function refuseChargebackRateReserve(user: UserRecord, payoutType: PayoutType): void {
  if (payoutType === PAYOUT_TYPE_INSTANT || isFlagSet(user, "payouts_paused_by_user")) return;
  if (
    isFlagSet(user, "payouts_paused_internally") &&
    jsonDataForAttr(user, "payouts_paused_by") === PAYOUT_PAUSE_SOURCE_SYSTEM
  )
    throw new NotPortedError(
      "a payout for a seller paused by the system (chargeback-rate reserve)",
      "app/business/payments/payouts/payouts.rb under_chargeback_rate_reserve?",
    );
}

const isPaused = (user: UserRecord) =>
  isFlagSet(user, "payouts_paused_internally") || isFlagSet(user, "payouts_paused_by_user");

// `select_and_claim_payable_balances`, up to the claim: which balances are payable and the minimum they are judged against.
export async function selectPayableBalances(
  user: UserRecord,
  date: Date,
  payoutType: PayoutType,
): Promise<HeldBalance[]> {
  const unpaid = await unpaidBalancesUpTo(user, date);
  const payable = await payableBalancesForProcessor(user, unpaid);
  await payoutMinimumCents(user, payoutType);
  return payable;
}

// `mark_balances_processing`, decided under the seller lock.
export function markBalancesProcessing(
  user: UserRecord,
  date: Date,
  payoutType: PayoutType = PAYOUT_TYPE_STANDARD,
): Promise<Claim> {
  return Users.withLock(user, async () => {
    refuseChargebackRateReserve(user, payoutType);
    if (isPaused(user)) return { balances: [], underReserve: false };
    return { balances: await selectPayableBalances(user, date, payoutType), underReserve: false };
  });
}
