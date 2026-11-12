// Port of the user side of a failed Stripe payout: StripePayoutProcessor.hold_payouts_for_unaccounted_money! and the part of
// reverse_internal_transfer_or_hold_payouts! that runs when there is no internal transfer to reverse. Golden:
// scripts/golden/payouts-create-payments.rb.
//
// Not ported, refused before anything is written: a payment with a stripe_internal_transfer_id (the reversal needs the
// Stripe calls of `reverse_internal_transfer!`), and the `rescue` of the Ruby method, which re-stamps UNREVERSED_INTERNAL_TRANSFER,
// retries the hold and reports once. An error raised by the hold propagates unchanged here.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { COMMENT_TYPES, Comments } from "./comment.ts";
import { Payments, paymentUser, type PaymentRecord } from "./payment.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { column, selectRows, table } from "./sql.ts";
import { isFlagSet, NotPortedError, setFlag, setJsonDataForAttr, Users } from "./user.ts";

export const UNACCOUNTED_MONEY_HOLD_MARKER = "could not be accounted for";
const PAYOUT_OUTCOME_UNKNOWN = "payout_outcome_unknown";
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

// reverse_internal_transfer_or_hold_payouts!(payment, failure_reason) for a payment that has no internal transfer.
export async function reverseInternalTransferOrHoldPayoutsBang(
  payment: PaymentRecord,
  failureReason: string | null,
  options: SaveOptions = {},
): Promise<void> {
  if (payment.get("stripe_internal_transfer_id") != null)
    throw new NotPortedError(
      "StripePayoutProcessor.reverse_internal_transfer! for a payment with an internal transfer",
      "app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb",
    );
  if (failureReason === PAYOUT_OUTCOME_UNKNOWN)
    await holdPayoutsForUnaccountedMoneyBang(payment, failureReason, options);
}
