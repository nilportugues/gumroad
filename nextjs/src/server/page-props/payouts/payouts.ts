// BalanceController#index: PayoutsPresenter, UserBalanceStatsService#fetch_payout_periods and PayoutsHelper
// (app/helpers/payouts_helper.rb) for the Payouts page.
//
// What the port cannot prove goes to Rails whole (`HandBackToRails`, decided before the page renders by
// `planPayouts`): daily payouts, a chargeback-rate reserve, a seller that may be eligible for instant payouts
// (Stripe is asked about the bank account), a cached balance-stats blob, a PayPal connected account, an
// account in a currency other than USD and bank account classes whose routing number is not derivable.
import { Prisma, type User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { getRedis } from "../../infra/redis.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { type MerchantAccountRow, isStripeConnectAccount } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { jsonDataForAttr, RISK_STATES, UserFlags, Users } from "../../models/user.ts";
import { NotPortedError } from "../not-ported.ts";
import { payoutFacts } from "../settings/payments.ts";
import { taxCenterEnabled } from "../dashboard/tax-center.ts";
import PAYMENTS_DATA from "../settings/payments-data.generated.json" with { type: "json" };
import DATA from "./payouts-data.generated.json" with { type: "json" };
import { payoutSalesData, type SalesData } from "./payout-stats.ts";
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
type Row = Record<string, unknown>;

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

export type BankAccountRow = { id: bigint; type: string | null; bank_number: string | null; branch_code: string | null; account_number_last_four: string | null; stripe_bank_account_id: string | null; stripe_connect_account_id: string | null };

const PAYMENT_COLUMNS = Prisma.raw(["id", "user_id", "state", "created_at", "amount_cents", "payment_address", "payout_period_end_date", "bank_account_id", "stripe_connect_account_id", "currency", "json_data"].map((name) => `payments.\`${name}\``).join(", "));
const BANK_COLUMNS = Prisma.raw(["id", "type", "bank_number", "branch_code", "account_number_last_four", "stripe_bank_account_id", "stripe_connect_account_id"].map((name) => `bank_accounts.\`${name}\``).join(", "));

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
  sumOf(Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid'`);
const unpaidBalanceCentsUpToDate = (userId: bigint, date: Date) =>
  sumOf(Prisma.sql`SELECT CAST(COALESCE(SUM(balances.amount_cents), 0) AS SIGNED) AS value FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid' AND balances.date <= ${ymd(date)}`);
const paidPaymentsCentsForDate = (userId: bigint, date: Date) =>
  sumOf(
    Prisma.sql`SELECT CAST(COALESCE(SUM(payments.amount_cents), 0) AS SIGNED) AS value FROM payments WHERE payments.user_id = ${userId} AND payments.payout_period_end_date = ${ymd(date)} AND payments.state IN (${Prisma.join(PAYMENT_STATES_PAID_FOR_DATE)})`,
  );

type UnpaidBalance = { id: number; merchant_account_id: number | null };
const unpaidBalancesUpToDate = (userId: bigint, date: Date) =>
  selectRows<UnpaidBalance>(Prisma.sql`SELECT balances.id, balances.merchant_account_id FROM balances WHERE balances.user_id = ${userId} AND balances.state = 'unpaid' AND balances.date <= ${ymd(date)} ORDER BY balances.id ASC`);

// `user.payments.where("date(created_at) = ?", Date.today).first.present?`
const paidOn = async (userId: bigint, date: Date) =>
  (await one(Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${userId} AND date(payments.created_at) = ${ymd(date)} LIMIT 1`)) !== null;

async function activeBankAccount(userId: bigint): Promise<BankAccountRow | null> {
  return one<BankAccountRow>(Prisma.sql`SELECT ${BANK_COLUMNS} FROM bank_accounts WHERE bank_accounts.user_id = ${userId} AND bank_accounts.deleted_at IS NULL ORDER BY bank_accounts.id ASC LIMIT 1`);
}

const bankAccountById = (id: bigint) => one<BankAccountRow>(Prisma.sql`SELECT ${BANK_COLUMNS} FROM bank_accounts WHERE bank_accounts.id = ${id} LIMIT 1`);

// ---- bank accounts ----

// BankAccount#routing_number for the class in the `type` column (the subclass templates over the bank and branch codes).
function routingNumber(bank: BankAccountRow): string | null {
  const templates = (ROUTING as Record<string, Record<string, string | null | { unsupported: unknown }>>)[bank.type ?? "AchAccount"];
  if (!templates) throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  const key = `${bank.bank_number === null ? "-" : "bn"}${bank.branch_code === null ? "-" : "br"}`;
  const template = templates[key];
  if (template === undefined || (template !== null && typeof template === "object")) throw new NotPortedError(`BankAccount#routing_number for ${bank.type}`);
  return template === null ? null : template.replace("{bank_number}", bank.bank_number ?? "").replace("{branch_code}", bank.branch_code ?? "");
}

// BankAccount#to_hash. No class defines bank_name, so it is never part of the hash.
function bankAccountHash(bank: BankAccountRow) {
  const type = bank.type ?? "AchAccount";
  const accountType = (DATA.bankAccountType as Record<string, string>)[type];
  if (accountType === undefined) throw new NotPortedError(`BankAccount#bank_account_type for ${type}`);
  return { bank_number: bank.bank_number, routing_number: routingNumber(bank), account_number: `******${bank.account_number_last_four}`, bank_account_type: accountType };
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
const merchantAccountById = (id: number) => one<MerchantAccountRow & { currency: string | null }>(Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.id = ${id} LIMIT 1`);
const merchantAccountsOf = (userId: bigint) => selectRows<MerchantAccountRow>(Prisma.sql`SELECT merchant_accounts.* FROM merchant_accounts WHERE merchant_accounts.user_id = ${userId}`);

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
function displayedAmount(payment: PaymentRow): string {
  if (payment.currency !== "usd") throw new NotPortedError(`Money formatting for the payout currency ${payment.currency}`);
  return formattedDollarAmount(num(payment.amount_cents), { noCentsIfWhole: false });
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
  frequency: PayoutFrequency;
};

const completedDisplayable = (userId: bigint) => Prisma.sql`FROM payments WHERE payments.user_id = ${userId} AND payments.state = 'completed' AND payments.created_at >= ${OLDEST_DISPLAYABLE}`;

// PayoutsPresenter#validated_page_num
function validatedPageNumber(requested: number, count: number): number {
  const totalPages = Math.ceil(count / C.pastPaymentsPerPage);
  if (requested <= 0) return 1;
  if (requested > totalPages && totalPages !== 0) return totalPages;
  return requested;
}

// String#to_i
export function rubyToI(value: string | null | undefined): number {
  const match = /^\s*[-+]?\d[\d_]*/.exec(value ?? "");
  return match ? Number(match[0].replaceAll("_", "")) : 0;
}

// UserBalanceStatsService#should_use_cache?: a large seller's payout periods come from a cached blob that a job refreshes.
async function balanceStatsCacheApplies(userId: bigint): Promise<boolean> {
  const row = await one<{ sales_count: number | null }>(Prisma.sql`SELECT large_sellers.sales_count FROM large_sellers WHERE large_sellers.user_id = ${userId} LIMIT 1`);
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

export async function planPayouts(seller: Seller, pageParam: string | null, now = new Date()): Promise<PayoutsPlan> {
  const record = Users.load(seller);
  const frequency = jsonDataForAttr(record, "payout_frequency", "weekly");
  if (!PAYOUT_FREQUENCIES.includes(frequency as PayoutFrequency)) throw new HandBackToRails();
  if (frequency === "daily") throw new HandBackToRails();
  if (await balanceStatsCacheApplies(seller.id)) throw new HandBackToRails();

  const facts = await payoutFacts(seller, now);
  if (facts.chargebackRateReserveActive) throw new HandBackToRails();
  // User#eligible_for_instant_payouts? asks Stripe about the bank account once the account is seasoned.
  const compliant = seller.user_risk_state === "compliant";
  const paused = UserFlags.isSet(seller.flags, "payouts_paused_internally") || UserFlags.isSet(seller.flags, "payouts_paused_by_user");
  if (compliant && !paused && facts.legalEntityCountry === "US" && (await one(Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'completed' LIMIT 1`)) !== null) {
    throw new HandBackToRails();
  }

  const count = await sumOf(Prisma.sql`SELECT COUNT(*) AS value ${completedDisplayable(seller.id)}`);
  const pageNumber = validatedPageNumber(rubyToI(pageParam), count);
  // Pagy raises an overflow for a page past the last one, which only happens with no payouts at all.
  const pages = Math.max(Math.ceil(count / C.pastPaymentsPerPage), 1);
  if (pageNumber > pages) throw new RangeError(`expected :page in 1..${pages}; got ${pageNumber}`);
  const offset = (pageNumber - 1) * C.pastPaymentsPerPage;

  const withBank = async (payments: PaymentRow[]) => Promise.all(payments.map(async (payment) => ({ payment, bank: payment.bank_account_id === null ? null : await bankAccountById(payment.bank_account_id) })));
  const past = await selectRows<PaymentRow>(Prisma.sql`SELECT ${PAYMENT_COLUMNS} ${completedDisplayable(seller.id)} ORDER BY payments.created_at DESC LIMIT ${C.pastPaymentsPerPage} OFFSET ${offset}`);
  const processing = await selectRows<PaymentRow>(Prisma.sql`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'processing' ORDER BY payments.created_at DESC`);
  const plan: PayoutsPlan = {
    seller,
    today: dateOnly(now),
    pageNumber,
    pages,
    pastPayments: await withBank(past),
    processingPayments: await withBank(processing),
    activeBank: await activeBankAccount(seller.id),
    frequency: frequency as PayoutFrequency,
  };

  // Everything the props would throw NotPortedError for: Rails serves those requests.
  try {
    for (const { payment, bank } of [...plan.pastPayments, ...plan.processingPayments]) {
      displayedAmount(payment);
      if (payment.payout_period_end_date === null) throw new NotPortedError("A payout without a period end date");
      if (bank) bankAccountHash(bank);
    }
    if (plan.activeBank) bankAccountHash(plan.activeBank);
    if (!present(seller.payment_address) && plan.activeBank === null && (await paypalConnectAccountExists(seller.id))) throw new NotPortedError("PayPal Connect payout email");
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

async function context(plan: PayoutsPlan, now: Date): Promise<Context> {
  const { seller } = plan;
  const facts = await payoutFacts(seller, now);
  const rail = payoutWeekday({ bankAccountType: plan.activeBank?.type ?? null, payoutsViaPaypal: false });
  const ledger: Ledger = {
    today: plan.today,
    frequency: plan.frequency,
    minimumPayoutAmountCents: await minimumPayoutAmountCents(seller, facts),
    daysBeforeCycleDate: daysBeforeCycleDate(rail),
    unpaidBalanceCents: () => unpaidBalanceCents(seller.id),
    unpaidBalanceCentsUpToDate: (date) => unpaidBalanceCentsUpToDate(seller.id, date),
    paidToday: () => paidOn(seller.id, plan.today),
  };
  return { plan, facts, ledger, merchantAccounts: await merchantAccountsOf(seller.id) };
}

// User#minimum_payout_amount_cents
async function minimumPayoutAmountCents(seller: Seller, facts: Facts): Promise<number> {
  if (facts.stripeAccountRejected) {
    const requested = await one(Prisma.sql`SELECT user_compliance_info_requests.id FROM user_compliance_info_requests WHERE user_compliance_info_requests.user_id = ${seller.id} AND user_compliance_info_requests.state = 'requested' LIMIT 1`);
    if (requested === null) return C.rejectedAccountMinAmountCents;
  }
  // json_data stores the writer's value uncast: `.to_i` of whatever is there.
  const stored = jsonDataForAttr(Users.load(seller), "payout_threshold_cents", facts.minimumPayoutThresholdCents);
  const threshold = typeof stored === "number" ? Math.trunc(stored) : typeof stored === "string" ? rubyToI(stored) : stored === null || stored === undefined ? 0 : rubyToI(String(stored));
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
    const payableCents = (await unpaidBalanceCentsUpToDate(seller.id, end)) + (await paidPaymentsCentsForDate(seller.id, end));
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
    data.displayable_payout_period_range = displayablePayoutPeriodRange(previous?.payout_period_end_date ?? null, end, plan.today);
    const balances = await unpaidBalancesUpToDate(seller.id, end);
    const payoutCents = await unpaidBalanceCentsUpToDate(seller.id, end);
    data.payout_cents = payoutCents;
    data.payout_displayed_amount = formattedDollarAmount(payoutCents, { noCentsIfWhole: false });
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
      const settled = (await unpaidBalanceCentsUpToDate(seller.id, end)) + (await paidPaymentsCentsForDate(seller.id, end));
      if (settled < minimum && unpaid >= minimum) data.settled_balance_cents = settled;
    }
  }

  let payoutNote: string | null = null;
  const note = await latestSellerVisiblePayoutNote(seller.id);
  if (note && present(note.content)) {
    const last = await one<{ created_at: Date }>(
      Prisma.sql`SELECT payments.created_at FROM payments WHERE payments.user_id = ${seller.id} AND (payments.state = 'completed' OR payments.state = 'processing') ORDER BY payments.id DESC LIMIT 1`,
    );
    if (epoch(note.created_at) > (last ? epoch(last.created_at) : 0)) payoutNote = note.content.replaceAll("via Stripe ", "");
  }
  const belowMinimum = payoutNote === null ? null : BELOW_MINIMUM_NOTE.exec(payoutNote);
  if (data.status === "not_payable" && belowMinimum && data.settled_balance_cents === undefined) {
    data.skipped_payout_date = belowMinimum.groups!.date;
    payoutNote = null;
  } else if (data.status === "not_payable" && seller.user_risk_state === "not_reviewed" && payoutNote !== null && UNDER_REVIEW_NOTE.test(payoutNote)) {
    payoutNote = null;
  }
  data.payout_note = payoutNote;
  return data;
}

// User#payouts_status
const payoutsStatus = (seller: Seller) => (UserFlags.isSet(seller.flags, "payouts_paused_internally") || UserFlags.isSet(seller.flags, "payouts_paused_by_user") ? "paused" : "payable");

// payout_method_details(user:)
async function payoutMethodDetailsForUser(ctx: Context, balances: UnpaidBalance[]) {
  const { plan, facts } = ctx;
  const { seller } = plan;
  // StripePayoutProcessor.get_payout_details(user, balances): the first Stripe-held balance's account.
  const held = await Promise.all(balances.map(async (balance) => (balance.merchant_account_id === null ? null : await merchantAccountById(balance.merchant_account_id))));
  const heldByStripe: (MerchantAccountRow & { currency: string | null })[] = [];
  for (const account of held) {
    if (account === null) throw new TypeError("undefined method 'holder_of_funds' for nil");
    if (holderOfFunds(account) === "stripe") heldByStripe.push(account);
  }
  const merchantAccount: (MerchantAccountRow & { currency?: string | null }) | null =
    facts.stripeConnectRoutingActive && heldByStripe.length === 0 ? facts.connectAccount : (facts.stripeAccount ?? heldByStripe[0] ?? null);
  const connectAccountId = merchantAccount && isStripeConnectAccount(merchantAccount) ? String(merchantAccount.charge_processor_merchant_id) : null;

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
  const currency = method === "bank" ? bankAccountCurrency(plan.activeBank!) : method === "stripe_connect" ? ((merchantAccount as { currency?: string | null }).currency ?? "usd") : "usd";
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
    data.displayable_payout_period_range = previousEnd.getTime() === endDate.getTime() ? `Activity on ${formattedEnd}` : `Activity from ${formattedPayoutDate(addDays(previousEnd, 1))} to ${formattedEnd}`;
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
  data.type = payoutType === null || payoutType === undefined || payoutType === false || payoutType === "" ? STANDARD_TYPE : payoutType;
  data.payout_note = null;

  const balanceIds = (
    await selectRows<{ id: number }>(Prisma.sql`SELECT balances.id FROM balances INNER JOIN payments_balances ON balances.id = payments_balances.balance_id WHERE payments_balances.payment_id = ${payment.id}`)
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
  const connectId = merchantAccount && isStripeConnectAccount(merchantAccount) ? payment.stripe_connect_account_id : null;
  if (connectId) return { ...data, payout_method_type: "stripe_connect", stripe_connect_account_id: connectId };
  if (bank) return { ...data, ...bankAccountHash(bank), payout_method_type: "bank" };
  if (present(payment.payment_address)) return { ...data, payout_method_type: "paypal", paypal_address: payment.payment_address };
  return { ...data, payout_method_type: "legacy-na" };
}

// PayoutsHelper#payout_period_data(user, payment)
const withCurrencyDisplay = async (ctx: Context, period: Period, isCurrent: boolean): Promise<Period> => {
  const { seller } = ctx.plan;
  const last = await one<{ currency: string | null }>(Prisma.sql`SELECT payments.currency FROM payments WHERE payments.user_id = ${seller.id} ORDER BY payments.id DESC LIMIT 1`);
  const shown = seller.currency_type !== "usd" || ![null, "usd"].includes(last?.currency ?? null);
  return { should_be_shown_currencies_always: shown, is_current_period: isCurrent, ...period };
};

// ---- props ----

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, ".000Z");

async function scheduledPayoutProps(seller: Seller) {
  if (!(RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state)) return null;
  const row = await one<{ action: string | null; status: string | null; scheduled_at: Date | null; payout_amount_cents: bigint | number | null }>(
    Prisma.sql`SELECT ${column("scheduled_payouts", "action")}, ${column("scheduled_payouts", "status")}, ${column("scheduled_payouts", "scheduled_at")}, ${column("scheduled_payouts", "payout_amount_cents")} FROM ${table("scheduled_payouts")} WHERE ${column("scheduled_payouts", "user_id")} = ${seller.id} AND ${column("scheduled_payouts", "status")} IN ('pending', 'flagged', 'held', 'executed') ORDER BY ${column("scheduled_payouts", "id")} DESC LIMIT 1`,
  );
  if (!row) return null;
  return { action: row.action, status: row.status, scheduled_at: row.scheduled_at === null ? null : iso(row.scheduled_at), payout_amount_cents: num(row.payout_amount_cents) };
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

  const period = async (data: Period, isCurrent: boolean) => withCurrencyDisplay(await ctx(), data, isCurrent);
  const connectRouting = async () => (await ctx()).facts.stripeConnectRoutingActive;

  return {
    next: async () => {
      // UserBalanceStatsService#next_payout_period_data: none while a standard payout is still processing.
      const pending = await one(
        Prisma.sql`SELECT payments.id FROM payments WHERE payments.user_id = ${seller.id} AND payments.state = 'processing' AND (JSON_UNQUOTE(JSON_EXTRACT(payments.json_data, '$.type')) != ${INSTANT_TYPE} OR JSON_EXTRACT(payments.json_data, '$.type') IS NULL) LIMIT 1`,
      );
      if (pending) return null;
      const data = await period(await currentPayoutPeriodData(await ctx()), true);
      return { ...data, stripe_connect_routing_active: await connectRouting() };
    },
    processing: async () => {
      const result: Period[] = [];
      for (const { payment, bank } of plan.processingPayments) {
        const data = await period(await oldPayoutPeriodData(await ctx(), payment, bank), false);
        result.push({ ...data, stripe_connect_routing_active: await connectRouting() });
      }
      return result;
    },
    past: async () => {
      const result: Period[] = [];
      for (const { payment, bank } of plan.pastPayments) result.push(await period(await oldPayoutPeriodData(await ctx(), payment, bank), false));
      return result;
    },
    rest: async () => ({
      payouts_status: payoutsStatus(seller),
      payouts_paused_by: (await ctx()).facts.payoutsPausedBySource,
      payout_reserve_percent: null,
      instant_payout: null,
      show_instant_payouts_notice: false,
      tax_center_enabled: await taxCenterEnabled(seller.id),
      pagination: { pages: plan.pages, page: plan.pageNumber },
      scheduled_payout: await scheduledPayoutProps(seller),
    }),
  };
}

export { DailyPayoutNotPorted, payoutPeriodEndDateForPayoutDate };
