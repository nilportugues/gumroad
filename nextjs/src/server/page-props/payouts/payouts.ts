// BalanceController#index: PayoutsPresenter, UserBalanceStatsService#fetch_payout_periods and PayoutsHelper
// (app/helpers/payouts_helper.rb) for the Payouts page.
//
// What the port cannot prove goes to Rails whole (`HandBackToRails`, decided before the page renders by
// `planPayouts`): daily payouts of a compliant seller (Payouts.is_user_payable), a seller whose payout account is
// seasoned for instant payouts (Stripe is asked about the bank account), a cached balance-stats blob that exists, a PayPal
// connected account and bank account classes whose routing number is not derivable. A daily seller that is not
// compliant is scheduled weekly, an unseasoned account rules instant payouts out, and payouts in a currency the
// money gem knows are formatted here.
// A cacheable seller whose blob is missing is computed live and the refresh job is enqueued, as in Rails.
// The chargeback-rate reserve is read from the ledger here (see `reserveBreakdown`).
import { Prisma, type User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { getRedis } from "../../infra/redis.ts";
import { enqueue } from "../../jobs/enqueue.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { knownCurrency, moneyFormatWithGemSymbol } from "../../models/concerns/money-formatter.ts";
import { type MerchantAccountRow, isStripeConnectAccount } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { balanceStatsCacheKey } from "../../models/user-balance-stats.ts";
import { jsonDataForAttr, RISK_STATES, UserFlags, Users } from "../../models/user.ts";
import { taxCenterEnabled } from "../dashboard/tax-center.ts";
import { NotPortedError } from "../not-ported.ts";
import PAYMENTS_DATA from "../settings/payments-data.generated.json" with { type: "json" };
import { payoutFacts } from "../settings/payments.ts";

import { emptyBalanceDestinationSeasoned } from "./instant-payout-eligibility.ts";
import {
  addDays,
  currentPayoutEndDate,
  daysBeforeCycleDate,
  dateOnly,
  displayablePayoutPeriodRange,
  DailyPayoutNotPorted,
  formattedPayoutDate,
  nextPayoutDate,
  payoutPeriodEndDateForPayoutDate,
  payoutWeekday,
  PAYOUT_FREQUENCIES,
  type Ledger,
  type PayoutFrequency,
} from "./payout-schedule.ts";
import { payoutSalesData, type SalesData } from "./payout-stats.ts";
import DATA from "./payouts-data.generated.json" with { type: "json" };

const C = DATA.constants;
const ROUTING = PAYMENTS_DATA.bankAccountRouting;
const GUMROAD_ADMIN_ID = PAYMENTS_DATA.constants.gumroadAdminId;
const BELOW_MINIMUM_NOTE = new RegExp(C.belowMinimumNoteRegex.replace("\\A", "^"), "u");
const UNDER_REVIEW_NOTE = new RegExp(C.underReviewNoteRegex.replace("\\A", "^").replace("\\z", "$"), "u");
const OLDEST_DISPLAYABLE = `${C.oldestDisplayablePayoutDate} 00:00:00`;
const SELLER_VISIBLE_FLAG = "seller_visible";
const INSTANT_TYPE = "instant";
const STANDARD_TYPE = "standard";
const PAYMENT_STATES_PAID_FOR_DATE = ["processing", "unclaimed", "completed"];

type Seller = User;

export type PaymentRow = {
  id: bigint;
  user_id: bigint;
  state: string | null;
  created_at: Date;
  amount_cents: bigint | number | null;
  payment_address: string | null;
  payout_period_end_date: Date | null;
  bank_account_id: bigint | null;
  stripe_connect_account_id: string | null;
  currency: string | null;
  json_data: string | null;
};

export type BankAccountRow = {
  id: bigint;
  type: string | null;
  bank_number: string | null;
  branch_code: string | null;
  account_number_last_four: string | null;
  stripe_bank_account_id: string | null;
  stripe_connect_account_id: string | null;
};

const PAYMENT_COLUMNS = Prisma.raw(
  [
    "id",
    "user_id",
    "state",
    "created_at",
    "amount_cents",
    "payment_address",
    "payout_period_end_date",
    "bank_account_id",
    "stripe_connect_account_id",
    "currency",
    "json_data",
  ]
    .map((name) => `payments.\`${name}\``)
    .join(", "),
);
const BANK_COLUMNS = Prisma.raw(
  [
    "id",
    "type",
    "bank_number",
    "branch_code",
    "account_number_last_four",
    "stripe_bank_account_id",
    "stripe_connect_account_id",
  ]
    .map((name) => `bank_accounts.\`${name}\``)
    .join(", "),
);

const num = (value: bigint | number | null | undefined) => (value == null ? 0 : Number(value));
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const ymd = (date: Date) => date.toISOString().slice(0, 10);

async function one<T>(sql: Prisma.Sql): Promise<T | null> {
  const [row] = await selectRows<T>(sql);
  return row ?? null;
}
async function sumOf(sql: Prisma.Sql): Promise<number> {
  const row = await one<{ value: bigint | number | null }>(sql);
  return num(row?.value);
}

// ---- the seller's ledger ----

const unpaidBalanceCents = (userId: bigint) =>
  sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid'`,
  );
const unpaidBalanceCentsUpToDate = (userId: bigint, date: Date) =>
  sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid' AND balances.date <= ${ymd(date)}`,
  );
const paidPaymentsCentsForDate = (userId: bigint, date: Date) =>
  sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(payments.amount_cents), 0) AS SIGNED) AS value FROM payments WHERE payments.user_id = ${userId} AND payments.payout_period_end_date = ${ymd(date)} AND payments.state IN (${Prisma.join(PAYMENT_STATES_PAID_FOR_DATE)})`,
  );

type UnpaidBalance = {
  id: number;
  merchant_account_id: number | null;
  date: Date;
  amount_cents: bigint | number | null;
};
const unpaidBalancesUpToDate = (userId: bigint, date: Date) =>
  selectRows<UnpaidBalance>(
    Prisma.sql`SELECT balances.id, balances.merchant_account_id, balances.date, balances.amount_cents FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid' AND balances.date <= ${ymd(date)} ORDER BY balances.id ASC`,
  );

// `user.payments.where("date(created_at) = ?", Date.today).first.present?`
const paidOn = async (userId: bigint, date: Date) =>
  (await one(
    Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${userId} AND date(payments.created_at) = ${ymd(date)} LIMIT 1`,
  )) !== null;

async function activeBankAccount(userId: bigint): Promise<BankAccountRow | null> {
  return one<BankAccountRow>(
    Prisma.sql`SELECT ${BANK_COLUMNS} FROM bank_accounts WHERE bank_accounts.user_id = ${userId} AND bank_accounts.deleted_at IS NULL ORDER BY bank_accounts.id ASC LIMIT 1`,
  );
}

const bankAccountById = (id: bigint) =>
  one<BankAccountRow>(Prisma.sql`SELECT ${BANK_COLUMNS} FROM bank_accounts WHERE bank_accounts.id = ${id} LIMIT 1`);

// ---- chargeback-rate payout reserve ----

const RESERVE_PERCENT = C.chargebackRatePayoutReservePercent;
const RESERVE_HOLD_PAYMENT_STATES = ["creating", "processing", "unclaimed", "completed"];

// Port of app/business/payments/payouts/payouts.rb Payouts.chargeback_rate_reserve_cents: ceil, so a 1-cent leftover cannot round the seller into a full payout.
export function chargebackRateReserveCents(unpaidCents: number): number {
  if (unpaidCents <= 0) return 0;
  return Math.ceil((unpaidCents * RESERVE_PERCENT) / 100.0);
}

// Port of app/modules/user/risk.rb User#chargeback_rate_payout_hold_started_at: the newest probation comment of a pausing author.
async function chargebackRateHoldStartedAt(userId: bigint): Promise<Date | null> {
  const row = await one<{ created_at: Date }>(
    Prisma.sql`SELECT comments.created_at FROM comments WHERE comments.commentable_id = ${userId} AND comments.commentable_type = 'User' AND comments.comment_type = 'on' AND comments.author_name IN (${Prisma.join(C.systemPayoutPausingAuthors)}) ORDER BY comments.created_at DESC, comments.id DESC LIMIT 1`,
  );
  return row?.created_at ?? null;
}

// Port of app/business/payments/payouts/payouts.rb Payouts.paid_cents_under_chargeback_rate_hold: USD balance cents of payouts made since the hold began, plus
// processing balances that no payment has claimed yet.
async function paidCentsUnderChargebackRateHold(userId: bigint): Promise<number> {
  const startedAt = await chargebackRateHoldStartedAt(userId);
  if (startedAt === null) return 0;
  const viaPayments = await sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM payments INNER JOIN payments_balances ON payments_balances.payment_id = payments.id INNER JOIN balances ON balances.id = payments_balances.balance_id WHERE payments.user_id = ${userId} AND payments.state IN (${Prisma.join(RESERVE_HOLD_PAYMENT_STATES)}) AND payments.created_at >= ${startedAt}`,
  );
  const claimedWithoutPayment = await sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM balances LEFT OUTER JOIN payments_balances ON payments_balances.balance_id = balances.id LEFT OUTER JOIN payments ON payments.id = payments_balances.payment_id WHERE balances.user_id = ${userId} AND balances.state = 'processing' AND payments.id IS NULL AND balances.updated_at >= ${startedAt}`,
  );
  return viaPayments + claimedWithoutPayment;
}

// Port of app/business/payments/payouts/payouts.rb Payouts.chargeback_rate_reserve_cents_for_run: 25% of (unpaid + paid under the hold), clamped to what is left.
async function chargebackRateReserveCentsForRun(userId: bigint, unpaidCents: number): Promise<number> {
  if (unpaidCents <= 0) return 0;
  return Math.min(
    chargebackRateReserveCents(unpaidCents + (await paidCentsUnderChargebackRateHold(userId))),
    unpaidCents,
  );
}

// Port of app/business/payments/payouts/payouts.rb Payouts.payable_cents_after_chargeback_rate_reserve (apply_chargeback_rate_reserve with the reserve active):
// the oldest whole rows that fit under the cap, nothing when that prefix misses the minimum.
export function payableCentsUnderReserve(
  balances: { date: Date; id: number; amount_cents: bigint | number | null }[],
  reserveCents: number,
  minimumCents: number,
): number {
  const cap = balances.reduce((sum, balance) => sum + num(balance.amount_cents), 0) - reserveCents;
  if (cap <= 0) return 0;
  let running = 0;
  const ordered = [...balances].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  for (const balance of ordered) {
    const cents = num(balance.amount_cents);
    if (cents <= 0) continue;
    if (running + cents > cap) break;
    running += cents;
  }
  return running < minimumCents ? 0 : running;
}

// The reserve fields of the current period (PayoutsHelper#current_payout_period_data).
async function reserveBreakdown(userId: bigint, balances: UnpaidBalance[], minimumCents: number) {
  const unpaidCents = balances.reduce((sum, balance) => sum + num(balance.amount_cents), 0);
  const reserve = await chargebackRateReserveCentsForRun(userId, unpaidCents);
  const payoutCents = payableCentsUnderReserve(balances, reserve, minimumCents);
  return {
    payout_cents: payoutCents,
    payout_reserve_cents: reserve,
    payout_waiting_cents: unpaidCents - reserve - payoutCents,
    payout_reserve_percent: RESERVE_PERCENT,
  };
}

// ---- bank accounts ----

// BankAccount#routing_number for the class in the `type` column (the subclass templates over the bank and branch codes).
function routingNumber(bank: BankAccountRow): string | null {
  const templates = (ROUTING as Record<string, Record<string, string | null | { unsupported: unknown }>>)[
    bank.type ?? "AchAccount"
  ];
  if (!templates) throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  const key = `${bank.bank_number === null ? "-" : "bn"}${bank.branch_code === null ? "-" : "br"}`;
  const template = templates[key];
  if (template === undefined || (template !== null && typeof template === "object"))
    throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  return template === null
    ? null
    : template.replace("{bank_number}", bank.bank_number ?? "").replace("{branch_code}", bank.branch_code ?? "");
}

// BankAccount#to_hash. No class defines bank_name, so it is never part of the hash.
function bankAccountHash(bank: BankAccountRow) {
  const type = bank.type ?? "AchAccount";
  const accountType = (DATA.bankAccountType as Record<string, string>)[type];
  if (accountType === undefined) throw new NotPortedError(`BankAccount#bank_account_type for ${type}`);
  return {
    bank_number: bank.bank_number,
    routing_number: routingNumber(bank),
    account_number: `******${bank.account_number_last_four}`,
    bank_account_type: accountType,
  };
}
const bankAccountCurrency = (bank: BankAccountRow) => {
  const currency = (DATA.bankAccountCurrency as Record<string, string>)[bank.type ?? "AchAccount"];
  if (currency === undefined) throw new NotPortedError(`BankAccount#currency for ${bank.type}`);
  return currency;
};

// ---- merchant accounts ----

// MerchantAccount#holder_of_funds
function holderOfFunds(account: MerchantAccountRow): "gumroad" | "stripe" | "creator" {
  if (account.charge_processor_id === "stripe") {
    if (isStripeConnectAccount(account)) return "creator";
    return account.user_id != null ? "stripe" : "gumroad";
  }
  return "gumroad";
}
const merchantAccountById = (id: number) =>
  one<MerchantAccountRow & { currency: string | null }>(
    Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.id = ${id} LIMIT 1`,
  );
const merchantAccountsOf = (userId: bigint) =>
  selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.user_id = ${userId}`,
  );

// ---- notes ----

type CommentRow = { content: string | null; json_data: string | null; created_at: Date };

// PayoutNoteVisibility.seller_visible?
function sellerVisible(note: CommentRow): boolean {
  const data = present(note.json_data) ? (JSON.parse(note.json_data) as Record<string, unknown> | null) : null;
  const flag = data?.[SELLER_VISIBLE_FLAG];
  if (flag !== undefined && flag !== null) return flag === true;
  const content = (note.content ?? "").toLowerCase();
  return !DATA.legacyInternalNotePrefixes.some((prefix) => content.startsWith(prefix.toLowerCase()));
}

// User#latest_seller_visible_payout_note
async function latestSellerVisiblePayoutNote(userId: bigint): Promise<CommentRow | null> {
  const notes = await selectRows<CommentRow>(
    Prisma.sql`SELECT comments.content, comments.json_data, comments.created_at FROM comments WHERE comments.commentable_id = ${userId} AND comments.commentable_type = 'User' AND comments.comment_type = 'payout_note' AND comments.deleted_at IS NULL AND comments.author_id = ${GUMROAD_ADMIN_ID} ORDER BY comments.created_at DESC, comments.id DESC LIMIT ${C.maxPayoutNotesScanned}`,
  );
  return notes.find(sellerVisible) ?? null;
}

// ---- money ----

// Payment#displayed_amount(no_cents_if_whole: false), for the one currency the port formats.
export function displayedAmount(payment: PaymentRow): string {
  if (payment.currency === "usd") return formattedDollarAmount(num(payment.amount_cents), { noCentsIfWhole: false });
  // Money.new(amount_cents, currency).format(symbol: true, with_currency: currency != "usd"); a missing or unknown currency is Rails' to raise.
  if (payment.currency === null || !knownCurrency(payment.currency))
    throw new NotPortedError(`Money formatting for the payout currency ${payment.currency}`);
  return moneyFormatWithGemSymbol(num(payment.amount_cents), payment.currency, {
    noCentsIfWhole: false,
    withCurrency: true,
  });
}

const epoch = (date: Date) => Math.floor(date.getTime() / 1000);

// ---- the plan: everything decided before the page renders ----

export type PayoutsPlan = {
  seller: Seller;
  today: Date;
  pageNumber: number;
  pages: number;
  // Past payouts of the requested page, newest first, with the bank account each paid into.
  pastPayments: { payment: PaymentRow; bank: BankAccountRow | null }[];
  processingPayments: { payment: PaymentRow; bank: BankAccountRow | null }[];
  activeBank: BankAccountRow | null;
  // `eligible_for_instant_payouts? && !active_bank_account&.supports_instant_payouts?`, served only where the second is true.
  showInstantPayoutsNotice: boolean;
  frequency: PayoutFrequency;
  // Stored as daily, scheduled as weekly (see planPayouts).
  dailyFallback: boolean;
  // A cacheable seller whose blob is missing: the page computes live and enqueues UpdateUserBalanceStatsCacheWorker.
  refreshBalanceStatsCache: boolean;
  // The blob's two periods, when one exists: Rails serves them as stored, however stale, and still enqueues the refresh.
  cached: CachedPeriods | null;
};

type CachedPeriods = { next: Record<string, unknown> | null; processing: Record<string, unknown>[] };

const completedDisplayable = (userId: bigint) =>
  Prisma.sql`FROM payments WHERE payments.user_id = ${userId} AND payments.state = 'completed' AND payments.created_at >= ${OLDEST_DISPLAYABLE}`;

// PayoutsPresenter#validated_page_num
function validatedPageNumber(requested: number, count: number): number {
  const totalPages = Math.ceil(count / C.pastPaymentsPerPage);
  if (requested <= 0) return 1;
  if (requested > totalPages && totalPages !== 0) return totalPages;
  return requested;
}

// String#to_i
export function rubyToI(value: string | null | undefined): number {
  const match = /^\s*[-+]?\d[\d_]*/u.exec(value ?? "");
  return match ? Number(match[0].replaceAll("_", "")) : 0;
}

// UserBalanceStatsService#should_use_cache?: a large seller's payout periods come from a cached blob that a job refreshes.
export async function balanceStatsCacheApplies(userId: bigint): Promise<boolean> {
  const row = await one<{ sales_count: number | null }>(
    Prisma.sql`SELECT large_sellers.sales_count FROM large_sellers WHERE large_sellers.user_id = ${userId} LIMIT 1`,
  );
  if (row === null) return false;
  try {
    const redis = getRedis("main");
    const threshold = (await redis.get("balance_stats:sales_caching_threshold")) ?? "50000";
    if ((row.sales_count ?? 0) < rubyToI(threshold)) return false;
    const excluded = await redis.smembers("balance_stats:users_excluded_from_caching");
    return !excluded.some((id) => rubyToI(id) === Number(userId));
  } catch {
    // An unreadable exclusion set caches nobody (REDIS_TRANSPORT_ERRORS).
    return false;
  }
}

// UserBalanceStatsService#read_cache: a blob that is absent, unparseable or JSON null/false is a miss (null here), and so is an
// unreadable Redis.
export async function readBalanceStatsBlob(userId: bigint): Promise<unknown> {
  try {
    const data = await getRedis("main").get(balanceStatsCacheKey(userId));
    if (data === null) return null;
    const parsed: unknown = JSON.parse(data);
    return parsed === false ? null : parsed;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// `cached.slice(:next_payout_period_data, :processing_payout_periods_data)` and what the presenter then does with each key.
// A blob that makes Rails raise (no processing list, a period that is not a hash) is served by Rails.
function cachedPeriods(blob: unknown): CachedPeriods {
  if (!isRecord(blob)) throw new HandBackToRails();
  const next = blob.next_payout_period_data ?? null;
  const processing = blob.processing_payout_periods_data;
  if ((next !== null && !isRecord(next)) || !Array.isArray(processing) || !processing.every(isRecord))
    throw new HandBackToRails();
  return { next, processing };
}

// User#eligible_for_instant_payouts?. Stripe-held balances add a second candidate destination
// (StripePayoutProcessor.destination_merchant_account(user, held)) that is not ported, so they hand back.
async function eligibleForInstantPayouts(
  seller: Seller,
  facts: Awaited<ReturnType<typeof payoutFacts>>,
  compliant: boolean,
  today: Date,
  now: Date,
): Promise<boolean> {
  if (
    !compliant ||
    UserFlags.isSet(seller.flags, "payouts_paused_internally") ||
    UserFlags.isSet(seller.flags, "payouts_paused_by_user")
  )
    return false;
  const completed = await one(
    Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'completed' LIMIT 1`,
  );
  if (completed === null || facts.legalEntityCountry !== "US") return false;

  try {
    for (const balance of await unpaidBalancesUpToDate(seller.id, today)) {
      const account =
        balance.merchant_account_id === null ? null : await merchantAccountById(balance.merchant_account_id);
      if (account !== null && holderOfFunds(account) === "stripe") throw new HandBackToRails();
    }
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails();
    throw error;
  }
  return emptyBalanceDestinationSeasoned(
    seller.id,
    {
      connectRoutingActive: facts.stripeConnectRoutingActive,
      connect: facts.connectAccount,
      standard: facts.stripeAccount,
    },
    now,
  );
}

export async function planPayouts(seller: Seller, pageParam: string | null, now = new Date()): Promise<PayoutsPlan> {
  const record = Users.load(seller);
  const storedFrequency = jsonDataForAttr(record, "payout_frequency", "weekly");
  if (!PAYOUT_FREQUENCIES.includes(storedFrequency as PayoutFrequency)) throw new HandBackToRails();
  const compliant = seller.user_risk_state === "compliant";
  // A daily schedule pays only while Payouts.is_user_payable(INSTANT) holds, which needs instant_payouts_supported?. A
  // seller who could be supported hands back below (Stripe is asked), so any daily seller that gets that far is not
  // payable instantly and falls back to the weekly cycle (get_initial_payout_date).
  const frequency = storedFrequency === "daily" ? "weekly" : storedFrequency;
  const refreshBalanceStatsCache = await balanceStatsCacheApplies(seller.id);
  const blob = refreshBalanceStatsCache ? await readBalanceStatsBlob(seller.id) : null;
  const cached = blob === null ? null : cachedPeriods(blob);

  const facts = await payoutFacts(seller, now);
  const activeBank = await activeBankAccount(seller.id);
  const eligibleForInstant = await eligibleForInstantPayouts(seller, facts, compliant, dateOnly(now), now);
  // BankAccount#supports_instant_payouts? is false without both Stripe ids, and asks Stripe otherwise.
  if (
    eligibleForInstant &&
    activeBank &&
    present(activeBank.stripe_connect_account_id) &&
    present(activeBank.stripe_bank_account_id)
  )
    throw new HandBackToRails();

  const count = await sumOf(Prisma.sql`SELECT COUNT(*) AS value ${completedDisplayable(seller.id)}`);
  const pageNumber = validatedPageNumber(rubyToI(pageParam), count);
  // Pagy raises an overflow for a page past the last one, which only happens with no payouts at all.
  const pages = Math.max(Math.ceil(count / C.pastPaymentsPerPage), 1);
  if (pageNumber > pages) throw new RangeError(`expected :page in 1..${pages}; got ${pageNumber}`);
  const offset = (pageNumber - 1) * C.pastPaymentsPerPage;

  const withBank = async (payments: PaymentRow[]) =>
    Promise.all(
      payments.map(async (payment) => ({
        payment,
        bank: payment.bank_account_id === null ? null : await bankAccountById(payment.bank_account_id),
      })),
    );
  const past = await selectRows<PaymentRow>(
    Prisma.sql`SELECT ${PAYMENT_COLUMNS} ${completedDisplayable(seller.id)} ORDER BY payments.created_at DESC LIMIT ${C.pastPaymentsPerPage} OFFSET ${offset}`,
  );
  const processing = await selectRows<PaymentRow>(
    Prisma.sql`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'processing' ORDER BY payments.created_at DESC`,
  );
  const plan: PayoutsPlan = {
    seller,
    today: dateOnly(now),
    pageNumber,
    pages,
    pastPayments: await withBank(past),
    processingPayments: await withBank(processing),
    activeBank,
    showInstantPayoutsNotice: eligibleForInstant,
    frequency: frequency as PayoutFrequency,
    dailyFallback: storedFrequency === "daily",
    refreshBalanceStatsCache,
    cached,
  };

  // Everything the props would throw NotPortedError for: Rails serves those requests.
  try {
    for (const { payment, bank } of [...plan.pastPayments, ...plan.processingPayments]) {
      displayedAmount(payment);
      if (payment.payout_period_end_date === null) throw new NotPortedError("A payout without a period end date");
      if (bank) bankAccountHash(bank);
    }
    if (plan.activeBank) bankAccountHash(plan.activeBank);
    if (!present(seller.payment_address) && plan.activeBank === null && (await paypalConnectAccountExists(seller.id)))
      throw new NotPortedError("PayPal Connect payout email");
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails();
    throw error;
  }
  return plan;
}

async function paypalConnectAccountExists(userId: bigint): Promise<boolean> {
  return (
    (await one(
      Prisma.sql`SELECT merchant_accounts.id FROM merchant_accounts WHERE merchant_accounts.user_id = ${userId} AND merchant_accounts.deleted_at IS NULL AND merchant_accounts.charge_processor_alive_at IS NOT NULL AND merchant_accounts.charge_processor_deleted_at IS NULL AND merchant_accounts.charge_processor_id = 'paypal' LIMIT 1`,
    )) !== null
  );
}

// ---- payout periods ----

type Facts = Awaited<ReturnType<typeof payoutFacts>>;

type Context = { plan: PayoutsPlan; facts: Facts; ledger: Ledger; merchantAccounts: MerchantAccountRow[] };

type LedgerPlan = Pick<PayoutsPlan, "seller" | "today" | "frequency" | "dailyFallback" | "activeBank">;

async function buildLedger(plan: LedgerPlan, facts: Facts): Promise<Ledger> {
  const { seller } = plan;
  const rail = payoutWeekday({ bankAccountType: plan.activeBank?.type ?? null, payoutsViaPaypal: false });
  return {
    today: plan.today,
    frequency: plan.frequency,
    dailyFallback: plan.dailyFallback,
    minimumPayoutAmountCents: await minimumPayoutAmountCents(seller, facts),
    daysBeforeCycleDate: daysBeforeCycleDate(rail),
    unpaidBalanceCents: () => unpaidBalanceCents(seller.id),
    unpaidBalanceCentsUpToDate: (date) => unpaidBalanceCentsUpToDate(seller.id, date),
    paidToday: () => paidOn(seller.id, plan.today),
  };
}

async function context(plan: PayoutsPlan, now: Date): Promise<Context> {
  const { seller } = plan;
  const facts = await payoutFacts(seller, now);
  return { plan, facts, ledger: await buildLedger(plan, facts), merchantAccounts: await merchantAccountsOf(seller.id) };
}

// User#next_payout_date and #formatted_balance_for_next_payout_date, the pair the admin user info shows. A seller below the minimum payout
// has neither. A daily seller above it is paid by Payouts.is_user_payable(INSTANT), which asks Stripe: not ported.
export async function nextPayoutForAdmin(
  seller: Seller,
  now = new Date(),
): Promise<{ nextPayoutDate: Date | null; formattedBalance: string | null }> {
  const stored = jsonDataForAttr(Users.load(seller), "payout_frequency", "weekly");
  if (!PAYOUT_FREQUENCIES.includes(stored as PayoutFrequency)) throw new NotPortedError("An unknown payout frequency");
  const facts = await payoutFacts(seller, now);
  const plan: LedgerPlan = {
    seller,
    today: dateOnly(now),
    frequency: stored as PayoutFrequency,
    dailyFallback: false,
    activeBank: await activeBankAccount(seller.id),
  };
  const ledger = await buildLedger(plan, facts);
  if ((await ledger.unpaidBalanceCents()) < ledger.minimumPayoutAmountCents)
    return { nextPayoutDate: null, formattedBalance: null };
  if (stored === "daily") throw new NotPortedError("A daily payout schedule (Payouts.is_user_payable)");
  const date = await nextPayoutDate(ledger);
  if (date === null) return { nextPayoutDate: null, formattedBalance: null };
  const cents = await ledger.unpaidBalanceCentsUpToDate(payoutPeriodEndDateForPayoutDate(ledger, date));
  return { nextPayoutDate: date, formattedBalance: formattedDollarAmount(cents) };
}

// User#minimum_payout_amount_cents
async function minimumPayoutAmountCents(seller: Seller, facts: Facts): Promise<number> {
  if (facts.stripeAccountRejected) {
    const requested = await one(
      Prisma.sql`SELECT user_compliance_info_requests.id FROM user_compliance_info_requests WHERE user_compliance_info_requests.user_id = ${seller.id} AND user_compliance_info_requests.state = 'requested' LIMIT 1`,
    );
    if (requested === null) return C.rejectedAccountMinAmountCents;
  }
  // json_data stores the writer's value uncast: `.to_i` of whatever is there.
  const stored = jsonDataForAttr(Users.load(seller), "payout_threshold_cents", facts.minimumPayoutThresholdCents);
  const threshold =
    typeof stored === "number"
      ? Math.trunc(stored)
      : typeof stored === "string"
        ? rubyToI(stored)
        : stored === null || stored === undefined
          ? 0
          : rubyToI(String(stored));
  return Math.max(threshold, facts.minimumPayoutThresholdCents);
}

type Period = Record<string, unknown>;

// payout_period_data(user)
async function currentPayoutPeriodData(ctx: Context): Promise<Period> {
  const { plan, ledger } = ctx;
  const { seller } = plan;
  const minimum = ledger.minimumPayoutAmountCents;
  const data: Period = { minimum_payout_amount_cents: minimum };
  const unpaid = await unpaidBalanceCents(seller.id);
  const nextDate = unpaid >= minimum ? await nextPayoutDate(ledger) : null;

  let payable: boolean;
  if (unpaid >= minimum && nextDate) {
    const end = await currentPayoutEndDate(ledger);
    const payableCents =
      (await unpaidBalanceCentsUpToDate(seller.id, end)) + (await paidPaymentsCentsForDate(seller.id, end));
    payable = payableCents >= minimum;
  } else {
    payable = unpaid >= minimum;
  }
  data.is_user_payable = payable;

  if (payable) {
    data.status = payoutsStatus(seller);
    const previous = await one<PaymentRow>(
      Prisma.sql`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE payments.user_id = ${seller.id} AND (payments.state = 'completed' OR payments.state = 'processing') AND payments.created_at >= ${OLDEST_DISPLAYABLE} ORDER BY payments.created_at DESC LIMIT 1`,
    );
    const end = await currentPayoutEndDate(ledger);
    data.displayable_payout_period_range = displayablePayoutPeriodRange(
      previous?.payout_period_end_date ?? null,
      end,
      plan.today,
    );
    const balances = await unpaidBalancesUpToDate(seller.id, end);
    // Under the chargeback-rate hold the reserve decides what pays; its fields keep the Ruby key order.
    if (ctx.facts.chargebackRateReserveActive)
      Object.assign(data, await reserveBreakdown(seller.id, balances, minimum));
    else data.payout_cents = await unpaidBalanceCentsUpToDate(seller.id, end);
    data.payout_displayed_amount = formattedDollarAmount(data.payout_cents as number, { noCentsIfWhole: false });
    data.payout_date_formatted = formattedPayoutDate(await nextPayoutDate(ledger));
    data.type = STANDARD_TYPE;
    Object.assign(
      data,
      await payoutSalesData({
        userId: seller.id,
        balanceIds: balances.map((balance) => balance.id),
        startDate: previous?.payout_period_end_date ? addDays(previous.payout_period_end_date, 1) : null,
        endDate: end,
        merchantAccounts: ctx.merchantAccounts,
      }),
    );
    Object.assign(data, await payoutMethodDetailsForUser(ctx, balances));
  } else {
    data.status = "not_payable";
    data.balance_cents = unpaid;
    if (nextDate) {
      const end = await currentPayoutEndDate(ledger);
      const settled =
        (await unpaidBalanceCentsUpToDate(seller.id, end)) + (await paidPaymentsCentsForDate(seller.id, end));
      if (settled < minimum && unpaid >= minimum) data.settled_balance_cents = settled;
    }
  }

  let payoutNote: string | null = null;
  const note = await latestSellerVisiblePayoutNote(seller.id);
  if (note && present(note.content)) {
    const last = await one<{ created_at: Date }>(
      Prisma.sql`SELECT payments.created_at FROM payments WHERE payments.user_id = ${seller.id} AND (payments.state = 'completed' OR payments.state = 'processing') ORDER BY payments.id DESC LIMIT 1`,
    );
    if (epoch(note.created_at) > (last ? epoch(last.created_at) : 0))
      payoutNote = note.content.replaceAll("via Stripe ", "");
  }
  const belowMinimum = payoutNote === null ? null : BELOW_MINIMUM_NOTE.exec(payoutNote);
  if (data.status === "not_payable" && belowMinimum && data.settled_balance_cents === undefined) {
    data.skipped_payout_date = belowMinimum.groups!.date;
    payoutNote = null;
  } else if (
    data.status === "not_payable" &&
    seller.user_risk_state === "not_reviewed" &&
    payoutNote !== null &&
    UNDER_REVIEW_NOTE.test(payoutNote)
  ) {
    payoutNote = null;
  }
  data.payout_note = payoutNote;
  return data;
}

// User#payouts_status
const payoutsStatus = (seller: Seller) =>
  UserFlags.isSet(seller.flags, "payouts_paused_internally") || UserFlags.isSet(seller.flags, "payouts_paused_by_user")
    ? "paused"
    : "payable";

// payout_method_details(user:)
async function payoutMethodDetailsForUser(ctx: Context, balances: UnpaidBalance[]) {
  const { plan, facts } = ctx;
  const { seller } = plan;
  // StripePayoutProcessor.get_payout_details(user, balances): the first Stripe-held balance's account.
  const held = await Promise.all(
    balances.map(async (balance) =>
      balance.merchant_account_id === null ? null : await merchantAccountById(balance.merchant_account_id),
    ),
  );
  const heldByStripe: (MerchantAccountRow & { currency: string | null })[] = [];
  for (const account of held) {
    if (account === null) throw new TypeError("undefined method 'holder_of_funds' for nil");
    if (holderOfFunds(account) === "stripe") heldByStripe.push(account);
  }
  const merchantAccount: (MerchantAccountRow & { currency?: string | null }) | null =
    facts.stripeConnectRoutingActive && heldByStripe.length === 0
      ? facts.connectAccount
      : (facts.stripeAccount ?? heldByStripe[0] ?? null);
  const connectAccountId =
    merchantAccount && isStripeConnectAccount(merchantAccount)
      ? String(merchantAccount.charge_processor_merchant_id)
      : null;

  let details: Record<string, unknown>;
  let method: string;
  if (connectAccountId) {
    method = "stripe_connect";
    details = { payout_method_type: method, stripe_connect_account_id: connectAccountId };
  } else if (plan.activeBank) {
    method = "bank";
    details = { ...bankAccountHash(plan.activeBank), payout_method_type: method };
  } else if (present(seller.payment_address)) {
    method = "paypal";
    details = { payout_method_type: method, paypal_address: seller.payment_address };
  } else {
    method = "none";
    details = { payout_method_type: method };
  }
  // The destination decides the currency: a bank pays in its own, Stripe Connect in the account's, PayPal in USD.
  const currency =
    method === "bank"
      ? bankAccountCurrency(plan.activeBank!)
      : method === "stripe_connect"
        ? ((merchantAccount as { currency?: string | null }).currency ?? "usd")
        : "usd";
  details.payout_currency = currency;
  return details;
}

// payout_period_data(user, payment): a payout that has been made.
async function oldPayoutPeriodData(ctx: Context, payment: PaymentRow, bank: BankAccountRow | null): Promise<Period> {
  const { seller } = ctx.plan;
  const previous = await one<PaymentRow>(
    Prisma.sql`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE payments.user_id = ${seller.id} AND (payments.state = 'completed' OR payments.state = 'processing') AND payments.created_at >= ${OLDEST_DISPLAYABLE} AND payments.created_at <= ${payment.created_at} AND payments.id < ${payment.id} ORDER BY payments.created_at DESC LIMIT 1`,
  );
  const endDate = payment.payout_period_end_date!;
  const formattedEnd = formattedPayoutDate(endDate);
  const data: Period = {};
  if (previous) {
    const previousEnd = previous.payout_period_end_date!;
    data.displayable_payout_period_range =
      previousEnd.getTime() === endDate.getTime()
        ? `Activity on ${formattedEnd}`
        : `Activity from ${formattedPayoutDate(addDays(previousEnd, 1))} to ${formattedEnd}`;
  } else {
    data.displayable_payout_period_range = `Activity up to ${formattedEnd}`;
  }

  const json = present(payment.json_data) ? (JSON.parse(payment.json_data) as Record<string, unknown> | null) : null;
  const arrival = json?.arrival_date;
  data.payout_date_formatted = formattedPayoutDate(dateOnly(payment.created_at));
  data.payout_currency = payment.currency;
  data.payout_cents = num(payment.amount_cents);
  data.payout_displayed_amount = displayedAmount(payment);
  data.is_processing = payment.state === "processing";
  data.arrival_date = arrival ? formattedPayoutDate(dateOnly(new Date(Number(arrival) * 1000))) : null;
  data.status = payment.state;
  data.payment_external_id = externalId(payment.id);
  const payoutType = json?.payout_type;
  data.type =
    payoutType === null || payoutType === undefined || payoutType === false || payoutType === ""
      ? STANDARD_TYPE
      : payoutType;
  data.payout_note = null;

  const balanceIds = (
    await selectRows<{ id: number }>(
      Prisma.sql`SELECT balances.id FROM balances INNER JOIN payments_balances ON balances.id = payments_balances.balance_id WHERE payments_balances.payment_id = ${payment.id}`,
    )
  ).map((balance) => balance.id);
  const sales: SalesData = await payoutSalesData({
    userId: seller.id,
    balanceIds,
    startDate: previous?.payout_period_end_date ? addDays(previous.payout_period_end_date, 1) : null,
    endDate,
    merchantAccounts: ctx.merchantAccounts,
  });
  Object.assign(data, sales);

  const gumroadFee = json?.gumroad_fee_cents;
  if (gumroadFee !== null && gumroadFee !== undefined && gumroadFee !== "") {
    const fee = Number(gumroadFee);
    data.fees_cents = (Number(data.fees_cents) || 0) + fee;
    data.direct_fees_cents = (Number(data.direct_fees_cents) || 0) + fee;
  }

  // payout_method_details(payment:)
  const merchantAccount = await one<MerchantAccountRow>(
    payment.stripe_connect_account_id === null
      ? Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.user_id = ${seller.id} AND merchant_accounts.charge_processor_merchant_id IS NULL LIMIT 1`
      : Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.user_id = ${seller.id} AND merchant_accounts.charge_processor_merchant_id = ${payment.stripe_connect_account_id} LIMIT 1`,
  );
  const connectId =
    merchantAccount && isStripeConnectAccount(merchantAccount) ? payment.stripe_connect_account_id : null;
  if (connectId) return { ...data, payout_method_type: "stripe_connect", stripe_connect_account_id: connectId };
  if (bank) return { ...data, ...bankAccountHash(bank), payout_method_type: "bank" };
  if (present(payment.payment_address))
    return { ...data, payout_method_type: "paypal", paypal_address: payment.payment_address };
  return { ...data, payout_method_type: "legacy-na" };
}

// PayoutsHelper#payout_period_data(user, payment)
const withCurrencyDisplay = async (ctx: Context, period: Period, isCurrent: boolean): Promise<Period> => {
  const { seller } = ctx.plan;
  const last = await one<{ currency: string | null }>(
    Prisma.sql`SELECT payments.currency FROM payments WHERE payments.user_id = ${seller.id} ORDER BY payments.id DESC LIMIT 1`,
  );
  const shown = seller.currency_type !== "usd" || ![null, "usd"].includes(last?.currency ?? null);
  return { should_be_shown_currencies_always: shown, is_current_period: isCurrent, ...period };
};

// ---- props ----

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, ".000Z");

async function scheduledPayoutProps(seller: Seller) {
  if (!(RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state)) return null;
  const row = await one<{
    action: string | null;
    status: string | null;
    scheduled_at: Date | null;
    payout_amount_cents: bigint | number | null;
  }>(
    Prisma.sql`SELECT ${column("scheduled_payouts", "action")}, ${column("scheduled_payouts", "status")}, ${column("scheduled_payouts", "scheduled_at")}, ${column("scheduled_payouts", "payout_amount_cents")} FROM ${table("scheduled_payouts")} WHERE ${column("scheduled_payouts", "user_id")} = ${seller.id} AND ${column("scheduled_payouts", "status")} IN ('pending', 'flagged', 'held', 'executed') ORDER BY ${column("scheduled_payouts", "id")} DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    action: row.action,
    status: row.status,
    scheduled_at: row.scheduled_at === null ? null : iso(row.scheduled_at),
    payout_amount_cents: num(row.payout_amount_cents),
  };
}

export type PayoutsProps = {
  next: () => Promise<Period | null>;
  processing: () => Promise<Period[]>;
  past: () => Promise<Period[]>;
  rest: () => Promise<Record<string, unknown>>;
};

export function payoutsProps(plan: PayoutsPlan, now = new Date()): PayoutsProps {
  let cached: Promise<Context> | undefined;
  const ctx = () => (cached ??= context(plan, now));
  const { seller } = plan;
  // PayoutsPresenter#payout_periods is memoised: one enqueue per request, when the first of the two readers runs.
  let refreshed: Promise<unknown> | undefined;
  const refreshCache = () => {
    if (!plan.refreshBalanceStatsCache) return undefined;
    return (refreshed ??= enqueue("UpdateUserBalanceStatsCacheWorker", [Number(seller.id)]));
  };

  const period = async (data: Period, isCurrent: boolean) => withCurrencyDisplay(await ctx(), data, isCurrent);
  const connectRouting = async () => (await ctx()).facts.stripeConnectRoutingActive;

  return {
    next: async () => {
      await refreshCache();
      // `payout_periods[:next_payout_period_data]&.merge(stripe_connect_routing_active: ...)`
      if (plan.cached) {
        return plan.cached.next && { ...plan.cached.next, stripe_connect_routing_active: await connectRouting() };
      }
      // UserBalanceStatsService#next_payout_period_data: none while a standard payout is still processing.
      const pending = await one(
        Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'processing' AND (JSON_UNQUOTE(JSON_EXTRACT(payments.json_data, '$.type')) != ${INSTANT_TYPE} OR JSON_EXTRACT(payments.json_data, '$.type') IS NULL) LIMIT 1`,
      );
      if (pending) return null;
      const data = await period(await currentPayoutPeriodData(await ctx()), true);
      return { ...data, stripe_connect_routing_active: await connectRouting() };
    },
    processing: async () => {
      await refreshCache();
      if (plan.cached) {
        const routing = await connectRouting();
        return plan.cached.processing.map((item) => ({ ...item, stripe_connect_routing_active: routing }));
      }
      const result: Period[] = [];
      for (const { payment, bank } of plan.processingPayments) {
        const data = await period(await oldPayoutPeriodData(await ctx(), payment, bank), false);
        result.push({ ...data, stripe_connect_routing_active: await connectRouting() });
      }
      return result;
    },
    past: async () => {
      const result: Period[] = [];
      for (const { payment, bank } of plan.pastPayments)
        result.push(await period(await oldPayoutPeriodData(await ctx(), payment, bank), false));
      return result;
    },
    rest: async () => ({
      payouts_status: payoutsStatus(seller),
      payouts_paused_by: (await ctx()).facts.payoutsPausedBySource,
      payout_reserve_percent: (await ctx()).facts.chargebackRateReserveActive ? RESERVE_PERCENT : null,
      instant_payout: null,
      show_instant_payouts_notice: plan.showInstantPayoutsNotice,
      tax_center_enabled: await taxCenterEnabled(seller.id),
      pagination: { pages: plan.pages, page: plan.pageNumber },
      scheduled_payout: await scheduledPayoutProps(seller),
    }),
  };
}

export { DailyPayoutNotPorted, payoutPeriodEndDateForPayoutDate };
