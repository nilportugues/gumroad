// Port of the user side of a failed Stripe payout: StripePayoutProcessor.hold_payouts_for_unaccounted_money! and
// reverse_internal_transfer_or_hold_payouts! with its `rescue` (re-stamp UNREVERSED_INTERNAL_TRANSFER, a second hold attempt, one
// report). The reversal itself is payout-reversal.ts. Goldens: scripts/golden/payouts-create-payments.rb (the hold) and
// scripts/golden/payouts-reversal.rb (the reversal and the rescue).
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { notifyError } from "../infra/error-reporting.ts";

import { COMMENT_TYPES, Comments } from "./comment.ts";
import REASONS from "./payment-failure-reasons.generated.json" with { type: "json" };
import { Payments, paymentUser, type PaymentRecord } from "./payment.ts";
import { reverseInternalTransferOrDeferBang } from "./payout-reversal.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { column, selectRows, table } from "./sql.ts";
import { isFlagSet, setFlag, setJsonDataForAttr, Users } from "./user.ts";

export const UNACCOUNTED_MONEY_HOLD_MARKER = "could not be accounted for";
const PAYOUT_OUTCOME_UNKNOWN = "payout_outcome_unknown";
const UNREVERSED_INTERNAL_TRANSFER = "unreversed_internal_transfer";
// User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:repeated_failed_payouts]
const REPEATED_FAILED_PAYOUTS_AUTHOR = "pause_payouts_after_repeated_failures";
const PAYOUT_PAUSE_SOURCE_SYSTEM = "system";

// String#inspect for the two shapes the comment interpolates: nil, or a plain ASCII string.
const rubyInspect = (value: string | null) => (value === null ? "nil" : JSON.stringify(value));

// hold_payouts_for_unaccounted_money!. The comment is written even when the seller is already paused: the most recent pausing
// comment is what identifies the live hold.
export async function holdPayoutsForUnaccountedMoneyBang(
  payment: PaymentRecord,
  failureReason: string | null,
  options: SaveOptions = {},
): Promise<void> {
  const user = (await paymentUser(payment))!;
  // lock! raises on unpersisted changes, and a user read through json_data earlier in the payout carries one; the hold needs the row
  // as the database has it.
  if (user.hasChangesToSave()) await Users.reload(user);
  const marker = `payout ${encrypt(payment.get("id"))} ${UNACCOUNTED_MONEY_HOLD_MARKER}`;
  await Users.withLock(user, async () => {
    if (!isFlagSet(user, "payouts_paused_internally")) {
      setFlag(user, "payouts_paused_internally", true);
      setJsonDataForAttr(user, "payouts_paused_by", PAYOUT_PAUSE_SOURCE_SYSTEM);
      await Users.saveBang(user, options);
    }
    const existing = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("comments")} WHERE ${column("comments", "commentable_id")} = ${user.get("id")} AND ${column("comments", "commentable_type")} = 'User' AND ${column("comments", "comment_type")} = ${COMMENT_TYPES.ON_PROBATION} AND ${column("comments", "author_name")} = ${REPEATED_FAILED_PAYOUTS_AUTHOR} AND (content LIKE ${`%${marker}%`}) LIMIT 1`,
    );
    if (existing.length > 0) return;
    // `payment.reload`: also drops the cached user, which the next hold on this instance reads again.
    const reloaded = await Payments.reload(payment);
    const transferId = reloaded.get("stripe_internal_transfer_id") ?? null;
    await Comments.createBang(
      {
        commentable_id: user.get("id") as never,
        commentable_type: "User",
        content: `Payouts paused automatically: ${marker} — it failed as ${String(reloaded.get("failure_reason"))} (original reason ${rubyInspect(failureReason)}), so Gumroad cannot tell from its own records whether the money reached the seller. Reconcile transfer ${rubyInspect(transferId)} and any bank payout at Stripe before resuming.`,
        comment_type: COMMENT_TYPES.ON_PROBATION,
        author_name: REPEATED_FAILED_PAYOUTS_AUTHOR,
      } as never,
      options,
    );
  });
}

// The Ruby `@payout_reversal_failure_notified`: SyncStuckPayoutsJob skips a second "rejected sync" alert for the payment.
export const payoutReversalFailureNotified = new WeakSet<PaymentRecord>();

// reverse_internal_transfer_or_hold_payouts!(payment, failure_reason, reraise:)
export async function reverseInternalTransferOrHoldPayoutsBang(
  payment: PaymentRecord,
  failureReason: string | null,
  options: SaveOptions & { reraise?: boolean } = {},
): Promise<void> {
  const { reraise = false, ...saveOptions } = options;
  try {
    await reverseInternalTransferOrDeferBang(payment, saveOptions);
    // An unknown payout outcome means Stripe may have accepted the bank payout even though the reversal succeeded.
    if (failureReason === PAYOUT_OUTCOME_UNKNOWN)
      await holdPayoutsForUnaccountedMoneyBang(payment, failureReason, saveOptions);
  } catch (reverseError) {
    // Re-stamp only a still-requeueable reason: an unknown outcome already blocks the requeue.
    if (failureReason !== null && REASONS.requeueable_reasons.includes(failureReason)) {
      payment.set("failure_reason", UNREVERSED_INTERNAL_TRANSFER);
      await Payments.saveBang(payment, saveOptions);
    }
    let holdError: Error | null = null;
    try {
      await holdPayoutsForUnaccountedMoneyBang(payment, failureReason, saveOptions);
    } catch (error) {
      holdError = error as Error;
    }
    const reversalMessage = reverseError instanceof Error ? reverseError.message : String(reverseError);
    notifyError(holdError ?? reverseError, {
      payment_id: payment.get("id"),
      user_id: payment.get("user_id"),
      stripe_internal_transfer_id: payment.get("stripe_internal_transfer_id"),
      original_failure_reason: failureReason,
      reverse_error: reversalMessage,
      hold_setup_failed: holdError !== null,
      action_required:
        holdError !== null
          ? "Payout reversal failed and the automatic payout hold could not be set. Pause this seller and reconcile at Stripe by hand."
          : "Payouts are paused for this seller. Reverse or reconcile this transfer at Stripe by hand, then resume payouts.",
    });
    payoutReversalFailureNotified.add(payment);
    // A failed hold must still raise: mark_failed! returned the balances to unpaid.
    if (holdError !== null) throw holdError;
    if (reraise) throw reverseError;
  }
}
