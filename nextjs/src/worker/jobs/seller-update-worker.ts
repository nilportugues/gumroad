// Port of app/sidekiq/seller_update_worker.rb: a seller with an email address who allows announcements is queued the weekly
// ContactingCreatorMailer#seller_update when last week (Sunday to Sunday, UTC) brought a positive net from sales and affiliate
// credits, or a new follower. The mailer stays in Ruby, so the ActiveJob push is built as `deliver_later(queue: "critical")` builds it.
// Rails runs all nine statements of `User#last_weeks_sales` before looking at followers, and so does this.
// Golden: __fixtures__/seller-update-worker.golden.json (scripts/golden/seller-update-worker.rb).
import { Prisma, type User } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { advance } from "../../server/models/concerns/ruby-time.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { UserFlags } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const MAILER = "ContactingCreatorMailer";
const METHOD = "seller_update";
const DAYS_IN_WEEK = 7;
const AFFILIATE_CREDITS = "affiliate_credits";
const AFFILIATE_PARTIAL_REFUNDS = "affiliate_partial_refunds";
const PURCHASES = "purchases";
const FOLLOWERS = "followers";
// Purchase.flag_mapping["flags"][:chargeback_reversed], which Rails binds as a quoted string.
const CHARGEBACK_REVERSED = "512";

// `Date.today.beginning_of_week(:sunday).to_datetime` and the week before it, as the UTC clock times Rails binds.
function lastWeek(now: Date): { start: Date; end: Date } {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = advance(midnight, { days: -midnight.getUTCDay() });
  return { start: advance(end, { days: -DAYS_IN_WEEK }), end };
}

// The only value of a one-column aggregate row; a SUM over no rows is NULL, which Rails casts to 0.
async function sum(statement: Prisma.Sql): Promise<bigint> {
  const [row] = await selectRows<Record<string, unknown>>(statement);
  const value = Object.values(row!)[0];
  return value === null || value === undefined ? 0n : BigInt(String(value));
}

const sumOf = (tableName: string, columnName: string) => Prisma.raw(`SUM(\`${tableName}\`.\`${columnName}\`)`);

// `affiliate_credits_sum_for_credits_created_between`: `affiliate_credit_sum_from_scope` over the paid scope and the all scope.
async function affiliateCredits(userId: bigint, start: Date, end: Date): Promise<bigint> {
  const own = Prisma.sql`${column(AFFILIATE_CREDITS, "affiliate_user_id")} = ${userId}`;
  const window = Prisma.sql`(affiliate_credits.created_at > ${start} AND affiliate_credits.created_at <= ${end} )`;
  const purchasesJoin = Prisma.sql`INNER JOIN ${table(PURCHASES)} ON ${column(PURCHASES, "id")} = ${column(AFFILIATE_CREDITS, "purchase_id")}`;
  const partiallyRefunded = Prisma.sql`${column(PURCHASES, "stripe_partially_refunded")} = TRUE`;

  const paid = await sum(
    Prisma.sql`SELECT ${sumOf(AFFILIATE_CREDITS, "amount_cents")} FROM ${table(AFFILIATE_CREDITS)} WHERE ${own} AND (affiliate_credit_refund_balance_id IS NULL AND affiliate_credit_chargeback_balance_id IS NULL) AND (affiliate_credit_success_balance_id IS NOT NULL) AND ${window}`,
  );
  const withRemainingValue = await sum(
    Prisma.sql`SELECT ${sumOf(AFFILIATE_CREDITS, "amount_cents")} FROM ${table(AFFILIATE_CREDITS)} ${purchasesJoin} WHERE ${own} AND ${window} AND ${partiallyRefunded} AND EXISTS (SELECT ${Prisma.raw("`affiliate_partial_refunds`.*")} FROM ${table(AFFILIATE_PARTIAL_REFUNDS)} WHERE (affiliate_partial_refunds.affiliate_credit_id = affiliate_credits.id))`,
  );
  const refunded = await sum(
    Prisma.sql`SELECT ${sumOf(AFFILIATE_PARTIAL_REFUNDS, "amount_cents")} FROM ${table(AFFILIATE_CREDITS)} ${purchasesJoin} INNER JOIN ${table(AFFILIATE_PARTIAL_REFUNDS)} ON ${column(AFFILIATE_PARTIAL_REFUNDS, "affiliate_credit_id")} = ${column(AFFILIATE_CREDITS, "id")} WHERE ${own} AND ${window} AND ${partiallyRefunded}`,
  );
  return paid + withRemainingValue - refunded;
}

// `User#last_weeks_sales > 0` (`total_from(paid_sales, affiliate_credits)`).
async function lastWeeksSalesArePositive(userId: bigint, start: Date, end: Date): Promise<boolean> {
  const credits = await affiliateCredits(userId, start, end);

  const paidSales = Prisma.sql`WHERE ${column(PURCHASES, "seller_id")} = ${userId} AND ${column(PURCHASES, "purchase_state")} = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & ${CHARGEBACK_REVERSED} != 0)) AND (purchases.created_at > ${start} and purchases.created_at <= ${end})`;
  const effectiveRefunds = Prisma.raw(
    "INNER JOIN `refunds` ON `refunds`.`purchase_id` = `purchases`.`id` AND (refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')",
  );
  const partialRefundsJoin = Prisma.sql`INNER JOIN ${table(AFFILIATE_PARTIAL_REFUNDS)} ON ${column(AFFILIATE_PARTIAL_REFUNDS, "purchase_id")} = ${column(PURCHASES, "id")}`;
  const fromPurchases = Prisma.sql`FROM ${table(PURCHASES)}`;

  let price =
    (await sum(Prisma.sql`SELECT ${sumOf(PURCHASES, "price_cents")} ${fromPurchases} ${paidSales}`)) + credits;
  let fee = await sum(Prisma.sql`SELECT ${sumOf(PURCHASES, "fee_cents")} ${fromPurchases} ${paidSales}`);
  fee += await sum(Prisma.sql`SELECT ${sumOf(PURCHASES, "affiliate_credit_cents")} ${fromPurchases} ${paidSales}`);
  price -= await sum(
    Prisma.sql`SELECT ${sumOf("refunds", "amount_cents")} ${fromPurchases} ${effectiveRefunds} ${paidSales}`,
  );
  fee -= await sum(
    Prisma.sql`SELECT ${sumOf("refunds", "fee_cents")} ${fromPurchases} ${effectiveRefunds} ${paidSales}`,
  );
  fee -= await sum(
    Prisma.sql`SELECT ${sumOf(AFFILIATE_PARTIAL_REFUNDS, "amount_cents")} ${fromPurchases} ${partialRefundsJoin} ${paidSales}`,
  );
  return price - fee > 0n;
}

// `User#last_weeks_followers > 0`
async function lastWeeksFollowersExist(userId: bigint, start: Date, end: Date): Promise<boolean> {
  return (
    (await sum(
      Prisma.sql`SELECT COUNT(*) FROM ${table(FOLLOWERS)} WHERE ${column(FOLLOWERS, "followed_id")} = ${userId} AND ${column(FOLLOWERS, "deleted_at")} IS NULL AND ${column(FOLLOWERS, "confirmed_at")} IS NOT NULL AND (created_at > ${start} and created_at <= ${end})`,
    )) > 0n
  );
}

// `user.form_email.present?`: the unconfirmed address wins when it is not blank.
const hasFormEmail = (user: User) => !isBlank(isBlank(user.unconfirmed_email) ? user.email : user.unconfirmed_email);

export const sellerUpdateWorkerWith = modelJob({ min: 1 }, async ([userId], deps, { runtime }) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  const user = await findByIdBang<User>("User", id);
  if (!hasFormEmail(user) || !UserFlags.isSet(user.flags, "announcement_notification_enabled")) return;

  const { start, end } = lastWeek(deps.now());
  if (!(await lastWeeksSalesArePositive(id, start, end)) && !(await lastWeeksFollowersExist(id, start, end))) return;

  await deliverLater(
    runtime,
    { mailer: MAILER, method: METHOD, args: [Number(user.id)], queue: "critical" },
    mailRoute(MAILER, METHOD),
  );
});

export const sellerUpdateWorker = sellerUpdateWorkerWith();
