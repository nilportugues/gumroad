// Port of app/sidekiq/reconcile_stripe_payouts_pause_for_seller_job.rb up to Stripe: every exit before `Stripe::Account.retrieve` runs in
// Node (a missing user, a suspended, flagged or deleted one, a pause that is not Stripe's, an unaccounted-money hold, no Gumroad-managed
// account, no Stripe account id). A seller whose pause may be lifted needs the Stripe read, the locked re-check and the resume writer, so
// the job is handed back right before the Stripe call, with nothing written.
// Golden: __fixtures__/reconcile-stripe-payouts-pause-for-seller-job.golden.json
// (scripts/golden/reconcile-stripe-payouts-pause-for-seller-job.rb).
import { Prisma, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { COMMENT_TYPES, COMMENTS, commentsOf, withType } from "../../server/models/comment.ts";
import { stripeAccountOf } from "../../server/models/merchant-account.ts";
import { UNACCOUNTED_MONEY_HOLD_MARKER } from "../../server/models/payment-hold.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import {
  isDeleted,
  isFlagged,
  isFlagSet,
  isSuspended,
  payoutsPausedBy,
  Users,
  type UserRecord,
} from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

// User::PAYOUT_PAUSE_SOURCE_STRIPE
const PAYOUT_PAUSE_SOURCE_STRIPE = "stripe";
// User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:repeated_failed_payouts]
const REPEATED_FAILED_PAYOUTS_AUTHOR = "pause_payouts_after_repeated_failures";

// String#blank?
const blank = (value: unknown) => value == null || (typeof value === "string" && /^[\s\u0085]*$/u.test(value));

// `unaccounted_money_hold?`: a repeated-failed-payouts probation comment carrying the marker, since the last resume if there is one.
async function unaccountedMoneyHold(userId: bigint): Promise<boolean> {
  const [resumed] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT MAX(${column(COMMENTS, "created_at")}) FROM ${table(COMMENTS)} WHERE ${commentsOf("User", userId)} AND ${withType(COMMENT_TYPES.PAYOUTS_RESUMED)}`,
  );
  const lastResumedAt = resumed ? (Object.values(resumed)[0] as Date | null) : null;
  const since = lastResumedAt === null ? Prisma.empty : Prisma.sql` AND (created_at >= ${lastResumedAt})`;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(COMMENTS)} WHERE ${commentsOf("User", userId)} AND ${withType(COMMENT_TYPES.ON_PROBATION)} AND ${column(COMMENTS, "author_name")} = ${REPEATED_FAILED_PAYOUTS_AUTHOR} AND (content LIKE ${`%${UNACCOUNTED_MONEY_HOLD_MARKER}%`})${since} LIMIT 1`,
  );
  return rows.length > 0;
}

// `stripe_paused?`
async function stripePaused(user: UserRecord): Promise<boolean> {
  if (isSuspended(user) || isFlagged(user) || isDeleted(user)) return false;
  if (!isFlagSet(user, "payouts_paused_internally") || payoutsPausedBy(user) !== PAYOUT_PAUSE_SOURCE_STRIPE)
    return false;
  return !(await unaccountedMoneyHold(user.get("id")));
}

export const reconcileStripePayoutsPauseForSellerJobWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = userId === null ? null : await beforeSideEffects(() => recordIdFrom(userId, "User.find_by"));
  const row = await findOneBy<User>("User", "id", id, true);
  if (row === null) return;
  const user = Users.load(row);
  if (!(await stripePaused(user))) return;

  const account = await stripeAccountOf(user.get("id"));
  if (account === null) return;
  if (blank(account.charge_processor_merchant_id)) return;

  throw new HandBackToRuby("the Stripe read and the locked resume of a Stripe payout pause are not ported");
});

export const reconcileStripePayoutsPauseForSellerJob = reconcileStripePayoutsPauseForSellerJobWith();
