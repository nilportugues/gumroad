// Port of app/sidekiq/release_chargeback_rate_payout_pause_for_seller_job.rb up to the lock: every exit before `with_lock` runs in Node
// (a missing user, a suspended, flagged or deleted one, a hold that is not the system's chargeback-rate hold, no sales volume, and a
// rate above the limit). A seller whose hold would be lifted needs the locked re-check, the validated `update!` and the audit comment,
// so the job is handed back right before the lock's BEGIN, with nothing written.
// Golden: __fixtures__/release-chargeback-rate-payout-pause-for-seller-job.golden.json
// (scripts/golden/release-chargeback-rate-payout-pause-for-seller-job.rb).
import { Prisma, type User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { COMMENT_TYPES } from "../../server/models/comment.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, quoteName, selectRows, table } from "../../server/models/sql.ts";
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

const PURCHASES = "purchases";
const COMMENTS = "comments";
// User::MAX_CHARGEBACK_RATE_ALLOWED_FOR_PAYOUTS
const MAX_CHARGEBACK_RATE_ALLOWED_FOR_PAYOUTS = 1.5;
// User::PAYOUT_CHARGEBACK_RATE_WINDOW
const PAYOUT_CHARGEBACK_RATE_WINDOW = { days: 365 };
// User::PAYOUT_PAUSE_SOURCE_SYSTEM and User::SYSTEM_PAYOUT_PAUSING_COMMENT_AUTHORS (repeated failed payouts, high chargeback rate)
const PAYOUT_PAUSE_SOURCE_SYSTEM = "system";
const SYSTEM_PAYOUT_PAUSING_COMMENT_AUTHORS = [
  "pause_payouts_after_repeated_failures",
  "pause_payouts_for_seller_based_on_chargeback_rate",
];
const HIGH_CHARGEBACK_RATE_AUTHOR = "pause_payouts_for_seller_based_on_chargeback_rate";
// Purchase.flag_mapping["flags"]: chargeback_reversed and is_bundle_product_purchase
const CHARGEBACK_REVERSED = 512;
const IS_BUNDLE_PRODUCT_PURCHASE = 67_108_864;
const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";

// `user.last_system_payout_pause_comment&.author_name`
async function lastSystemPayoutPauseAuthor(userId: bigint): Promise<string | null> {
  const [row] = await selectRows<{ author_name: string | null }>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(COMMENTS)}.*`)} FROM ${table(COMMENTS)} WHERE ${column(COMMENTS, "commentable_id")} = ${userId} AND ${column(COMMENTS, "commentable_type")} = 'User' AND ${column(COMMENTS, "comment_type")} = ${COMMENT_TYPES.ON_PROBATION} AND ${column(COMMENTS, "author_name")} IN (${Prisma.join(SYSTEM_PAYOUT_PAUSING_COMMENT_AUTHORS, ", ")}) ORDER BY ${column(COMMENTS, "created_at")} DESC, ${column(COMMENTS, "id")} DESC LIMIT 1`,
  );
  return row?.author_name ?? null;
}

// `releasable?`: not suspended, flagged or deleted, and `payouts_paused_for_chargeback_rate?`.
async function isReleasable(user: UserRecord): Promise<boolean> {
  if (isSuspended(user) || isFlagged(user)) return false;
  if (isDeleted(user)) return false;
  if (!isFlagSet(user, "payouts_paused_internally")) return false;
  if (payoutsPausedBy(user) !== PAYOUT_PAUSE_SOURCE_SYSTEM) return false;
  return (await lastSystemPayoutPauseAuthor(user.get("id"))) === HIGH_CHARGEBACK_RATE_AUTHOR;
}

// `user.lost_chargebacks_for_payout_gate[:volume]` (`chargeback_rates`), as the percentage string Ruby formats, or "NA".
async function chargebackVolumePercentage(userId: bigint, now: Date): Promise<string> {
  const lost = `purchases.chargeback_date IS NOT NULL AND purchases.flags & ${CHARGEBACK_REVERSED} = 0`;
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*), COALESCE(SUM(purchases.price_cents), 0), COUNT(CASE WHEN ${Prisma.raw(lost)} THEN 1 END), COALESCE(SUM(CASE WHEN ${Prisma.raw(lost)} THEN purchases.price_cents ELSE 0 END), 0) FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "seller_id")} = ${userId} AND ${column(PURCHASES, "purchase_state")} = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND ((${column(PURCHASES, "flags")} & ${IS_BUNDLE_PRODUCT_PURCHASE} = 0)) AND (COALESCE(purchases.charge_processor_id, '') != ${PAYPAL_CHARGE_PROCESSOR_ID}) AND (purchases.created_at >= ${ago(PAYOUT_CHARGEBACK_RATE_WINDOW, now)}) LIMIT 1`,
  );
  const [, volumeDenominator, , volumeNumerator] = Object.values(row!).map((value) => Number(String(value)));
  // `format("%.1f%%", ...)`; a tie at one decimal (x.25, x.75) rounds differently from C's printf, but never across the 1.5 limit.
  return volumeDenominator! > 0 ? `${((volumeNumerator! / volumeDenominator!) * 100).toFixed(1)}%` : "NA";
}

export const releaseChargebackRatePayoutPauseForSellerJobWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const id = userId === null ? null : await beforeSideEffects(() => recordIdFrom(userId, "User.find_by"));
  const row = await findOneBy<User>("User", "id", id, true);
  if (row === null) return;
  const user = Users.load(row);
  if (!(await isReleasable(user))) return;

  const volumePercentage = await chargebackVolumePercentage(user.get("id"), deps.now());
  // "NA": no settled sales volume to divide by, so the hold stays.
  if (volumePercentage === "NA") return;
  if (Number.parseFloat(volumePercentage) > MAX_CHARGEBACK_RATE_ALLOWED_FOR_PAYOUTS) return;

  throw new HandBackToRuby("the locked release of a chargeback-rate payout hold is not ported");
});

export const releaseChargebackRatePayoutPauseForSellerJob = releaseChargebackRatePayoutPauseForSellerJobWith();
