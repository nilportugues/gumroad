// The sales figures behind a payout period: PayoutsHelper#payout_sales_data and the User::Stats methods it
// calls (app/modules/user/stats.rb), for balances, PayPal sales and Stripe Connect sales. Each figure is the
// aggregate Rails runs, written as the one statement it comes to; the page props are proven by replaying
// recorded renders (payouts.replay.test.ts).
import { Prisma } from "@prisma/client";

import { PurchaseFlags } from "../../search/flags.ts";
import { selectRows } from "../../models/sql.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "../../models/merchant-account.ts";

const raw = (sql: string) => Prisma.raw(sql);

// Refund.effective (app/models/refund.rb)
const EFFECTIVE_REFUND = raw(
  "(refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')",
);
const WAIVED = PurchaseFlags.condition("is_refund_chargeback_fee_waived", true);
const NOT_WAIVED = PurchaseFlags.condition("is_refund_chargeback_fee_waived", false);
const DISCOVER = PurchaseFlags.condition("was_discover_fee_charged", true);
const NOT_DISCOVER = PurchaseFlags.condition("was_discover_fee_charged", false);
const CHARGEBACK_REVERSED_BIT = PurchaseFlags.bit("chargeback_reversed");
const NOT_CHARGEBACK_REVERSED = PurchaseFlags.condition("chargeback_reversed", false);
const REFUND_JOIN = raw("INNER JOIN refunds ON refunds.purchase_id = purchases.id AND " + EFFECTIVE_REFUND.sql);
const DISCOVER_BIT = PurchaseFlags.bit("was_discover_fee_charged");

async function sumOf(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<{ value: bigint | number | null }>(sql);
  return row?.value == null ? 0 : Number(row.value);
}

// `relation.sum(expression)`: an integer column's SUM is read as a signed integer.
const sumFrom = (expression: string, from: Prisma.Sql) => sumOf(Prisma.sql`SELECT CAST(COALESCE(SUM(${raw(expression)}), 0) AS SIGNED) AS value ${from}`);
const countFrom = (from: Prisma.Sql) => sumOf(Prisma.sql`SELECT COUNT(*) AS value ${from}`);

export type SalesData = {
  sales_cents: number;
  refunds_cents: number;
  chargebacks_cents: number;
  credits_cents: number;
  loan_repayment_cents: number;
  fees_cents: number;
  discover_fees_cents: number;
  direct_fees_cents: number;
  discover_sales_count: number;
  direct_sales_count: number;
  taxes_cents: number;
  affiliate_credits_cents: number;
  affiliate_fees_cents: number;
  paypal_payout_cents: number;
  stripe_connect_payout_cents: number;
};

// ---- balances ----

const inList = (ids: readonly number[]) => Prisma.join(ids);

type BalanceScope = { userId: bigint; ids: readonly number[] };
const sales = ({ userId }: BalanceScope, where: Prisma.Sql) => Prisma.sql`FROM purchases WHERE purchases.seller_id = ${userId} AND ${where}`;
const salesWithRefunds = ({ userId }: BalanceScope, where: Prisma.Sql) => Prisma.sql`FROM purchases ${REFUND_JOIN} WHERE purchases.seller_id = ${userId} AND ${where}`;

// A figure that returns the fees back for refunds and chargebacks (`returned_*_fees_due_to_refunds_and_chargebacks`).
// `flag` narrows the sales to discover or direct ones; `writeOffFlag` does the same for the fee retention refund's purchase.
async function returnedFees(scope: BalanceScope, flag: Prisma.Sql | null, writeOffFlag: Prisma.Sql | null): Promise<number> {
  const { ids, userId } = scope;
  const narrowed = flag ? Prisma.sql`${flag} AND ` : Prisma.empty;
  const refundedWaived = await sumFrom("refunds.fee_cents", salesWithRefunds(scope, Prisma.sql`${narrowed}${WAIVED} AND purchases.purchase_refund_balance_id IN (${inList(ids)})`));
  const refundedNotWaived = await sumFrom(
    "refunds.fee_cents - COALESCE(refunds.json_data->'$.retained_fee_cents', 0)",
    salesWithRefunds(scope, Prisma.sql`${narrowed}${NOT_WAIVED} AND purchases.purchase_refund_balance_id IN (${inList(ids)})`),
  );
  const disputedWhere = Prisma.sql`${narrowed}purchases.purchase_chargeback_balance_id IN (${inList(ids)})`;
  const disputedFee = (await sumFrom("purchases.fee_cents", sales(scope, disputedWhere))) - (await sumFrom("refunds.fee_cents", salesWithRefunds(scope, disputedWhere)));
  const writeOffJoin = writeOffFlag ? Prisma.sql`INNER JOIN purchases ON purchases.id = refunds.purchase_id` : Prisma.empty;
  const writeOffWhere = writeOffFlag ? Prisma.sql`AND ${writeOffFlag}` : Prisma.empty;
  const writtenOff = await sumFrom(
    "balance_transactions.issued_amount_net_cents",
    Prisma.sql`FROM balance_transactions INNER JOIN credits ON credits.id = balance_transactions.credit_id INNER JOIN refunds ON refunds.id = credits.fee_retention_refund_id ${writeOffJoin} WHERE balance_transactions.id = CAST(refunds.json_data->>'$.fee_retention_write_off_transaction_id' AS UNSIGNED) AND balance_transactions.user_id = ${userId} AND balance_transactions.balance_id IN (${inList(ids)}) ${writeOffWhere}`,
  );
  return refundedWaived + refundedNotWaived + disputedFee + writtenOff;
}

async function feesCents(scope: BalanceScope, flag: Prisma.Sql | null, writeOffFlag: Prisma.Sql | null): Promise<number> {
  const narrowed = flag ? Prisma.sql`${flag} AND ` : Prisma.empty;
  const revenue = await sumFrom("purchases.fee_cents", sales(scope, Prisma.sql`${narrowed}purchases.purchase_success_balance_id IN (${inList(scope.ids)})`));
  return revenue - (await returnedFees(scope, flag, writeOffFlag));
}

// affiliate_credit_sum_from_scope(paid_scope, all_scope) - refunded_cents
async function affiliateCreditsCents({ userId, ids }: BalanceScope): Promise<number> {
  const owner = Prisma.sql`affiliate_credits.affiliate_user_id = ${userId}`;
  const paid = await sumFrom(
    "affiliate_credits.amount_cents",
    Prisma.sql`FROM affiliate_credits WHERE ${owner} AND affiliate_credits.affiliate_credit_refund_balance_id IS NULL AND affiliate_credits.affiliate_credit_chargeback_balance_id IS NULL AND affiliate_credits.affiliate_credit_success_balance_id IN (${inList(ids)})`,
  );
  const partiallyRefunded = Prisma.sql`FROM affiliate_credits INNER JOIN purchases ON purchases.id = affiliate_credits.purchase_id WHERE ${owner} AND affiliate_credits.affiliate_credit_success_balance_id IN (${inList(ids)}) AND purchases.stripe_partially_refunded = TRUE`;
  const withRemaining = await sumFrom(
    "affiliate_credits.amount_cents",
    Prisma.sql`${partiallyRefunded} AND EXISTS (SELECT 1 FROM affiliate_partial_refunds WHERE affiliate_partial_refunds.affiliate_credit_id = affiliate_credits.id)`,
  );
  const partialRefundCents = await sumFrom(
    "affiliate_partial_refunds.amount_cents",
    Prisma.sql`FROM affiliate_credits INNER JOIN purchases ON purchases.id = affiliate_credits.purchase_id INNER JOIN affiliate_partial_refunds ON affiliate_partial_refunds.affiliate_credit_id = affiliate_credits.id WHERE ${owner} AND affiliate_credits.affiliate_credit_success_balance_id IN (${inList(ids)}) AND purchases.stripe_partially_refunded = TRUE`,
  );
  const refunded = await sumFrom(
    "affiliate_credits.amount_cents",
    Prisma.sql`FROM affiliate_credits WHERE ${owner} AND (affiliate_credits.affiliate_credit_refund_balance_id IN (${inList(ids)}) OR affiliate_credits.affiliate_credit_chargeback_balance_id IN (${inList(ids)})) AND affiliate_credits.affiliate_credit_success_balance_id NOT IN (${inList(ids)})`,
  );
  return paid + withRemaining - partialRefundCents - refunded;
}

// affiliate_fee_cents_for_balances
async function affiliateFeesCents(scope: BalanceScope): Promise<number> {
  const { userId, ids } = scope;
  const success = Prisma.sql`purchases.purchase_success_balance_id IN (${inList(ids)})`;
  const base = await sumFrom("purchases.affiliate_credit_cents", sales(scope, Prisma.sql`${success} AND purchases.purchase_refund_balance_id IS NULL AND purchases.purchase_chargeback_balance_id IS NULL`));
  const partial = await sumFrom("purchases.affiliate_credit_cents", sales(scope, Prisma.sql`${success} AND purchases.stripe_partially_refunded = TRUE`));
  const otherBalances = Prisma.sql`purchases.seller_id = ${userId} AND purchases.purchase_success_balance_id NOT IN (${inList(ids)})`;
  const refunded = await sumFrom(
    "balance_transactions.holding_amount_net_cents",
    Prisma.sql`FROM balance_transactions WHERE balance_transactions.refund_id IN (SELECT refunds.id FROM refunds WHERE refunds.purchase_id IN (SELECT purchases.id FROM purchases WHERE ${otherBalances} AND purchases.purchase_refund_balance_id IN (${inList(ids)}))) AND balance_transactions.user_id != ${userId}`,
  );
  const disputed = await sumFrom(
    "balance_transactions.holding_amount_net_cents",
    Prisma.sql`FROM balance_transactions WHERE balance_transactions.dispute_id IN (SELECT disputes.id FROM disputes WHERE disputes.purchase_id IN (SELECT purchases.id FROM purchases WHERE ${otherBalances} AND purchases.purchase_chargeback_balance_id IN (${inList(ids)}))) AND balance_transactions.user_id != ${userId}`,
  );
  return base + partial + refunded + disputed;
}

const ZERO_BALANCE_FIGURES = {
  sales_cents: 0,
  refunds_cents: 0,
  chargebacks_cents: 0,
  credits_cents: 0,
  loan_repayment_cents: 0,
  fees_cents: 0,
  discover_fees_cents: 0,
  direct_fees_cents: 0,
  discover_sales_count: 0,
  direct_sales_count: 0,
  taxes_cents: 0,
  affiliate_credits_cents: 0,
  affiliate_fees_cents: 0,
};
type BalanceFigures = typeof ZERO_BALANCE_FIGURES;

// sales_data_for_balance_ids. With no balances every `IN ()` matches nothing, and so does each figure.
async function salesDataForBalanceIds(scope: BalanceScope): Promise<BalanceFigures> {
  const { userId, ids } = scope;
  if (ids.length === 0) return { ...ZERO_BALANCE_FIGURES };
  const success = Prisma.sql`purchases.purchase_success_balance_id IN (${inList(ids)})`;
  const refundBalance = Prisma.sql`purchases.purchase_refund_balance_id IN (${inList(ids)})`;
  const chargebackBalance = Prisma.sql`purchases.purchase_chargeback_balance_id IN (${inList(ids)})`;
  const credits = Prisma.sql`credits.user_id = ${userId} AND credits.balance_id IN (${inList(ids)})`;
  const loanCredit = raw("(credits.financing_paydown_purchase_id IS NOT NULL OR credits.json_data->>'$.stripe_loan_paydown_id' IS NOT NULL)");

  const chargebackedCents = (await sumFrom("purchases.price_cents", sales(scope, chargebackBalance))) - (await sumFrom("refunds.amount_cents", salesWithRefunds(scope, chargebackBalance)));
  const taxableSale = Prisma.sql`${success} AND purchases.purchase_state = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & ${CHARGEBACK_REVERSED_BIT} != 0))`;

  return {
    sales_cents: await sumFrom("purchases.price_cents", sales(scope, success)),
    refunds_cents: await sumFrom("refunds.amount_cents", salesWithRefunds(scope, refundBalance)),
    chargebacks_cents: chargebackedCents,
    credits_cents: await sumFrom(
      "credits.amount_cents",
      Prisma.sql`FROM credits WHERE ${credits} AND credits.financing_paydown_purchase_id IS NULL AND credits.json_data->>'$.stripe_loan_paydown_id' IS NULL AND credits.fee_retention_refund_id IS NULL`,
    ),
    loan_repayment_cents: await sumFrom(
      "COALESCE(balance_transactions.issued_amount_net_cents, credits.amount_cents)",
      Prisma.sql`FROM credits LEFT JOIN balance_transactions ON balance_transactions.credit_id = credits.id AND balance_transactions.balance_id = credits.balance_id WHERE ${loanCredit} AND ${credits}`,
    ),
    fees_cents: await feesCents(scope, null, null),
    discover_fees_cents: await feesCents(scope, DISCOVER, DISCOVER),
    direct_fees_cents: await feesCents(scope, NOT_DISCOVER, NOT_DISCOVER),
    discover_sales_count: await countFrom(sales(scope, Prisma.sql`${success} AND ${DISCOVER}`)),
    direct_sales_count: await countFrom(sales(scope, Prisma.sql`${success} AND ${NOT_DISCOVER}`)),
    taxes_cents: await sumFrom("purchases.tax_cents", sales(scope, taxableSale)),
    affiliate_credits_cents: await affiliateCreditsCents(scope),
    affiliate_fees_cents: await affiliateFeesCents(scope),
  };
}

// ---- PayPal and Stripe Connect sales, by duration ----

type Duration = { startDate: Date | null; endDate: Date | null };
type DurationFigures = Omit<BalanceFigures, "loan_repayment_cents" | "credits_cents" | "affiliate_credits_cents">;

// start_date.beginning_of_day / end_date.end_of_day as ActiveRecord quotes them.
const beginningOfDay = (date: Date) => `${date.toISOString().slice(0, 10)} 00:00:00`;
const endOfDay = (date: Date) => `${date.toISOString().slice(0, 10)} 23:59:59.999999`;

const rangeSql = (column: string, { startDate, endDate }: Duration) =>
  Prisma.sql`${startDate ? Prisma.sql`AND ${raw(column)} >= ${beginningOfDay(startDate)}` : Prisma.empty} ${endDate ? Prisma.sql`AND ${raw(column)} <= ${endOfDay(endDate)}` : Prisma.empty}`;

async function figuresForDuration(userId: bigint, processor: string, merchantAccountIds: number[] | null, duration: Duration): Promise<DurationFigures> {
  // `where(merchant_account_id: [])` matches nothing.
  const account = (column: string) => (merchantAccountIds === null ? Prisma.empty : Prisma.sql`AND ${raw(column)} IN (${merchantAccountIds.length === 0 ? Prisma.sql`NULL` : Prisma.join(merchantAccountIds)})`);
  const saleWhere = Prisma.sql`purchases.seller_id = ${userId} AND purchases.charge_processor_id = ${processor} ${account("purchases.merchant_account_id")}`;
  const successful = Prisma.sql`${saleWhere} AND purchases.purchase_state = 'successful' ${rangeSql("purchases.succeeded_at", duration)}`;
  const chargebacked = Prisma.sql`${saleWhere} AND purchases.purchase_state = 'successful' AND purchases.chargeback_date IS NOT NULL AND ${NOT_CHARGEBACK_REVERSED} ${rangeSql("purchases.chargeback_date", duration)}`;
  const refundsWhere = Prisma.sql`refunds.seller_id = ${userId} AND purchases.charge_processor_id = ${processor} ${account("purchases.merchant_account_id")} ${rangeSql("refunds.created_at", duration)}`;

  const saleFrom = (extra: Prisma.Sql = Prisma.empty) => Prisma.sql`FROM purchases WHERE ${successful} ${extra}`;
  const chargebackFrom = (extra: Prisma.Sql = Prisma.empty) => Prisma.sql`FROM purchases WHERE ${chargebacked} ${extra}`;
  const refundFrom = (extra: Prisma.Sql = Prisma.empty) => Prisma.sql`FROM refunds INNER JOIN purchases ON purchases.id = refunds.purchase_id WHERE ${EFFECTIVE_REFUND} AND ${refundsWhere} ${extra}`;
  const and = (condition: Prisma.Sql) => Prisma.sql`AND ${condition}`;
  const discoverRefund = Prisma.sql`AND purchases.flags & ${DISCOVER_BIT} > 0`;
  const directRefund = Prisma.sql`AND purchases.flags & ${DISCOVER_BIT} = 0`;

  const fees = async (sale: Prisma.Sql, refund: Prisma.Sql, chargeback: Prisma.Sql) =>
    (await sumFrom("purchases.fee_cents", saleFrom(sale))) - ((await sumFrom("refunds.fee_cents", refundFrom(refund))) + (await sumFrom("purchases.fee_cents", chargebackFrom(chargeback))));

  const salesCents = await sumFrom("purchases.price_cents", saleFrom());
  const refundsCents = await sumFrom("refunds.amount_cents", refundFrom());
  const chargebacksCents = await sumFrom("purchases.price_cents", chargebackFrom());
  const feesTotal = await fees(Prisma.empty, Prisma.empty, Prisma.empty);

  // `sum("purchases.affiliate_credit_cents * (refunds.amount_cents / purchases.price_cents)").round`
  const refundedAffiliateFee = await sumOf(
    Prisma.sql`SELECT CAST(ROUND(COALESCE(SUM(purchases.affiliate_credit_cents * (refunds.amount_cents / purchases.price_cents)), 0), 0) AS SIGNED) AS value ${refundFrom()}`,
  );
  const affiliateFees = (await sumFrom("purchases.affiliate_credit_cents", saleFrom())) - (refundedAffiliateFee + (await sumFrom("purchases.affiliate_credit_cents", chargebackFrom())));

  return {
    sales_cents: salesCents,
    refunds_cents: refundsCents,
    chargebacks_cents: chargebacksCents,
    fees_cents: feesTotal,
    discover_fees_cents: await fees(and(DISCOVER), discoverRefund, and(DISCOVER)),
    direct_fees_cents: await fees(and(NOT_DISCOVER), directRefund, and(NOT_DISCOVER)),
    discover_sales_count: await countFrom(saleFrom(and(DISCOVER))),
    direct_sales_count: await countFrom(saleFrom(and(NOT_DISCOVER))),
    // Refund has no tax_cents column of its own, so Rails' unqualified `sum(:tax_cents)` reads the purchase's.
    taxes_cents: (await sumFrom("purchases.tax_cents", saleFrom())) - ((await sumFrom("purchases.tax_cents", refundFrom())) + (await sumFrom("purchases.tax_cents", chargebackFrom()))),
    affiliate_fees_cents: affiliateFees,
  };
}

const payoutNet = (figures: DurationFigures) => figures.sales_cents - figures.refunds_cents - figures.chargebacks_cents - figures.fees_cents - figures.affiliate_fees_cents;

// ---- payout_sales_data ----

export type PayoutSalesDataInput = {
  userId: bigint;
  balanceIds: number[];
  // `previous_payment&.payout_period_end_date.try(:next)`
  startDate: Date | null;
  endDate: Date | null;
  merchantAccounts: MerchantAccountRow[];
};

export async function payoutSalesData({ userId, balanceIds, startDate, endDate, merchantAccounts }: PayoutSalesDataInput): Promise<SalesData> {
  const fromBalances = await salesDataForBalanceIds({ userId, ids: balanceIds });
  const duration: Duration = { startDate, endDate };
  const paypal = await figuresForDuration(userId, "paypal", null, duration);
  const connectIds = merchantAccounts.filter(isStripeConnectAccount).map((account) => Number(account.id));
  const connect = await figuresForDuration(userId, "stripe", connectIds, duration);

  const sum = (key: keyof DurationFigures) => fromBalances[key] + paypal[key] + connect[key];
  return {
    sales_cents: sum("sales_cents"),
    refunds_cents: sum("refunds_cents"),
    chargebacks_cents: sum("chargebacks_cents"),
    credits_cents: fromBalances.credits_cents,
    loan_repayment_cents: fromBalances.loan_repayment_cents,
    fees_cents: sum("fees_cents"),
    discover_fees_cents: sum("discover_fees_cents"),
    direct_fees_cents: sum("direct_fees_cents"),
    discover_sales_count: sum("discover_sales_count"),
    direct_sales_count: sum("direct_sales_count"),
    taxes_cents: sum("taxes_cents"),
    affiliate_credits_cents: fromBalances.affiliate_credits_cents,
    affiliate_fees_cents: sum("affiliate_fees_cents"),
    paypal_payout_cents: payoutNet(paypal),
    stripe_connect_payout_cents: payoutNet(connect),
  };
}
