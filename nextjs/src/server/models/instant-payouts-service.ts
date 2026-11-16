// Port of InstantPayoutsService#perform (app/services/instant_payouts_service.rb): the eligibility read, the balances an instant payout can
// claim, the minimum and the maximum, one Payouts.create_payments with the instant payout type, and StripePayoutProcessor.process_payments
// for each payment it returns. Golden: scripts/golden/payouts-instant-service.rb.
//
// Refused with NotPortedError, from rows already read and before the first write or Stripe POST: a payout Rails would split into several
// batches (more than $9,999 in balances) and balances that share a created_at (Ruby's sort_by is not stable, so the batch edge could land
// on either). Everything the reads and the claim refuse (Connect routing, a retired or foreign-currency Stripe-held balance, an unpaid
// balance the processor does not claim) stays refused earlier, so by the time a payment row exists the shapes perform_payment refuses
// cannot occur. Once the first payment exists nothing here throws: like the Ruby `rescue => error`, an error while a payment is processed
// is reported and counted as a failed payout.
import { notifyError } from "../infra/error-reporting.ts";

import type { BalanceRecord } from "./balance.ts";
import { instantlyPayableUnpaidBalances } from "./instant-payable-balances.ts";
import { instantPayoutsSupported } from "./instant-payouts-supported.ts";
import { PAYMENT_STATES } from "./payment.ts";
import { processPaymentsBang } from "./payout-perform.ts";
import { preparePaymentAndSetAmount } from "./payout-prepare.ts";
import {
  createPaymentsBang,
  MAXIMUM_INSTANT_PAYOUT_AMOUNT_CENTS,
  MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS,
  PAYOUT_TYPE_INSTANT,
} from "./payouts.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { NotPortedError, type UserRecord } from "./user.ts";

const SERVICE_REF = "app/services/instant_payouts_service.rb perform";
export const INSTANT_PAYOUT_NOT_ELIGIBLE = "Your account is not eligible for instant payouts at this time.";
export const INSTANT_PAYOUT_BELOW_MINIMUM = "You need at least $1 in settled balance to request an instant payout.";
export const INSTANT_PAYOUT_ABOVE_MAXIMUM =
  "Your balance exceeds the maximum instant payout amount. Please contact support for assistance.";
export const INSTANT_PAYOUT_FAILED = "Failed to process instant payout";

export type InstantPayoutsResult = { success: true } | { success: false; error: string };
// Set once a payment row may exist, from which a failure can no longer be handed back to Rails.
export type InstantPayoutProgress = { committed: boolean };

const dateOf = (balance: BalanceRecord) => balance.get("date") as unknown as Date;
const createdAtOf = (balance: BalanceRecord) => (balance.get("created_at") as unknown as Date).getTime();
const holdingCents = (balance: BalanceRecord) => Number(balance.get("holding_amount_cents") ?? 0);
const sumHolding = (balances: BalanceRecord[]) => balances.reduce((total, balance) => total + holdingCents(balance), 0);

// `balances.each_with_object([[]])`: a new batch whenever the next balance would take the running one past the maximum.
function batchesOf(balances: BalanceRecord[]): BalanceRecord[][] {
  const batches: BalanceRecord[][] = [[]];
  for (const balance of balances) {
    if (sumHolding(batches.at(-1)!) + holdingCents(balance) > MAXIMUM_INSTANT_PAYOUT_AMOUNT_CENTS) batches.push([]);
    batches.at(-1)!.push(balance);
  }
  return batches;
}

// `InstantPayoutsService.new(seller, date:).perform`
export async function performInstantPayouts(
  seller: UserRecord,
  date: Date,
  options: SaveOptions = {},
  progress: InstantPayoutProgress = { committed: false },
): Promise<InstantPayoutsResult> {
  if (!(await instantPayoutsSupported(seller, options))) return { success: false, error: INSTANT_PAYOUT_NOT_ELIGIBLE };

  const balances = (await instantlyPayableUnpaidBalances(seller, options))
    .filter((balance) => dateOf(balance).getTime() <= date.getTime())
    .sort((a, b) => createdAtOf(a) - createdAtOf(b));
  if (sumHolding(balances) < MINIMUM_INSTANT_PAYOUT_AMOUNT_CENTS)
    return { success: false, error: INSTANT_PAYOUT_BELOW_MINIMUM };
  if (balances.some((balance) => holdingCents(balance) > MAXIMUM_INSTANT_PAYOUT_AMOUNT_CENTS))
    return { success: false, error: INSTANT_PAYOUT_ABOVE_MAXIMUM };
  if (new Set(balances.map(createdAtOf)).size !== balances.length)
    throw new NotPortedError("balances created at the same instant, whose order Ruby leaves open", SERVICE_REF);
  const batches = batchesOf(balances);
  if (batches.length > 1) throw new NotPortedError("an instant payout split into several batches", SERVICE_REF);

  // From here on a payment row may exist, and a bank payout may have been requested.
  progress.committed = true;
  const payments = await createPaymentsBang(dateOf(batches[0]!.at(-1)!), seller, {
    payoutType: PAYOUT_TYPE_INSTANT,
    ...(options.now ? { now: options.now } : {}),
    prepare: (payment, claimed, merchantAccount, payoutCurrency) =>
      preparePaymentAndSetAmount(payment, claimed, merchantAccount, payoutCurrency, options, true),
  });
  const outcomes: boolean[] = [];
  for (const [payment, errors] of payments) {
    if (errors.length > 0) {
      outcomes.push(false);
      continue;
    }
    try {
      await processPaymentsBang([payment], options);
      outcomes.push(payment.get("state") !== PAYMENT_STATES.FAILED);
    } catch (error) {
      notifyError(error, { payment_id: payment.get("id") });
      outcomes.push(false);
    }
  }
  return outcomes.length > 0 && outcomes.every(Boolean)
    ? { success: true }
    : { success: false, error: INSTANT_PAYOUT_FAILED };
}
