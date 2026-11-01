// Read side of app/models/subscription.rb: the flags and the scopes the deactivation sweep uses, and
// the period logic the reminder jobs read (`alive?`, `end_time_of_subscription`, `overdue_for_charge?`,
// free trials, recurrence and `current_subscription_price_cents` for the shapes Node can price).
// Nothing here writes a subscriptions row.
//
// A `SubscriptionRecord` mirrors one loaded ActiveRecord object: `belongs_to` and `has_one`
// associations are loaded once per record, relation reads (`purchases.last`, `successful_purchases`)
// go to MySQL each time and rely on the query cache to be answered like Rails does. Methods call
// each other exactly as the Ruby does, repeats included, because the cache's hits (and the
// statements that follow a cache clear) depend on the order of the calls.
import { Prisma, type BasePrice, type InstallmentPlanSnapshot, type Link, type MerchantAccount, type PaymentOption, type ProductInstallmentPlan, type Purchase, type Subscription, type User } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { advance, type Duration } from "./concerns/ruby-time.ts";
import { type FlipperActor, isFeatureEnabled, userActor } from "../infra/flipper.ts";
import SUBSCRIPTION_DATA from "./subscription-data.generated.json" with { type: "json" };
import { aliveStripeAccountsOf, isStripeConnectAccount, type MerchantAccountRow } from "./merchant-account.ts";
import { isChargedbackNotReversedOrRefunded, PURCHASES } from "./purchase.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { castRow, column, quoteName, selectRows, table } from "./sql.ts";
import { NotPortedError, UserFlags } from "./user.ts";
import { PurchaseFlags } from "../search/flags.ts";

export const SUBSCRIPTIONS = "subscriptions";

export const SubscriptionFlags = defineFlags(
  SUBSCRIPTIONS,
  {
    1: "is_test_subscription",
    2: "cancelled_by_buyer",
    3: "cancelled_by_admin",
    4: "DEPRECATED_flat_fee_applicable",
    5: "is_resubscription_pending_confirmation",
    6: "mor_fee_applicable",
    7: "is_installment_plan",
    8: "renewal_disabled_due_to_indian_card_mandate",
    9: "indian_card_mandate_requires_reauthorization",
    10: "vat_exempt_territory",
    11: "indian_card_mandate_hold_pending",
  },
  { queryMode: "bit_operator" },
);

// A string `where` clause is wrapped in parentheses by ActiveRecord.
const wrapped = (sql: Prisma.Sql) => Prisma.sql`(${sql})`;

// `not_is_test_subscription` (flag_shih_tzu's scope).
export const notIsTestSubscription = () => wrapped(SubscriptionFlags.condition("is_test_subscription", false));

export const DEACTIVATION_COLUMNS = ["cancelled_at", "failed_at", "ended_at"] as const;

// `Subscription.where("<column> < ? and deactivated_at is null", now).not_is_test_subscription`, the
// relations of FindExpiredSubscriptionsToSetAsDeactivatedWorker. `now` is quoted with its fraction:
// a raw clause is not cast to the column's precision.
export function pastAndNotDeactivated(columnName: (typeof DEACTIVATION_COLUMNS)[number], now: Date): Prisma.Sql {
  return Prisma.sql`${wrapped(Prisma.sql`${Prisma.raw(columnName)} < ${now} and deactivated_at is null`)} AND ${notIsTestSubscription()}`;
}

// ---------------------------------------------------------------------------------------------
// BasePrice::Recurrence

export const RECURRENCE_TO_NUMBER_OF_MONTHS: Readonly<Record<string, number>> = { monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24 };
const RECURRENCE_TO_RENEWAL_REMINDER_EMAIL_DAYS: Readonly<Record<string, number>> = { monthly: 1, quarterly: 7, biannually: 7, yearly: 7, every_two_years: 7 };
const LONG_RENEWAL_THRESHOLD_IN_MONTHS = 12;
const LONG_RENEWAL_ADVANCE_REMINDER_EMAIL_DAYS = 30;

const nilReceiver = (method: string, receiver = "nil") => new TypeError(`undefined method '${method}' for ${receiver}`);

// `BasePrice::Recurrence.seconds_in_recurrence`: a Duration of months, added with Time#advance.
export function periodOf(recurrence: string | null): Duration {
  const months = recurrence === null ? undefined : RECURRENCE_TO_NUMBER_OF_MONTHS[recurrence];
  if (months === undefined) throw nilReceiver("months");
  return { months };
}

// `BasePrice::Recurrence.renewal_reminder_email_days`, in days.
export function renewalReminderEmailDays(recurrence: string | null): number | undefined {
  return recurrence === null ? undefined : RECURRENCE_TO_RENEWAL_REMINDER_EMAIL_DAYS[recurrence];
}

// `BasePrice::Recurrence.renewal_advance_reminder_email_days`, in days; null for short recurrences.
export function renewalAdvanceReminderEmailDays(recurrence: string | null): number | null {
  const months = recurrence === null ? 0 : (RECURRENCE_TO_NUMBER_OF_MONTHS[recurrence] ?? 0);
  return months >= LONG_RENEWAL_THRESHOLD_IN_MONTHS ? LONG_RENEWAL_ADVANCE_REMINDER_EMAIL_DAYS : null;
}

// ---------------------------------------------------------------------------------------------
// Statements

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);
const SUBSCRIPTION_PURCHASES_SELECT = Prisma.sql`SELECT ${star(PURCHASES)} FROM ${table(PURCHASES)}`;
const forSubscription = (id: bigint) => Prisma.sql`${column(PURCHASES, "subscription_id")} = ${id}`;
const inState = (state: string) => Prisma.sql`${column(PURCHASES, "purchase_state")} = ${state}`;
// Purchase.not_fully_refunded / .not_chargedback_or_chargedback_reversed (chargeback_reversed is flag bit 512).
const NOT_FULLY_REFUNDED = Prisma.raw("(purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)");
const NOT_CHARGEDBACK_OR_REVERSED = Prisma.raw("(purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0))");

async function purchaseRows(sql: Prisma.Sql): Promise<Purchase[]> {
  return (await selectRows(sql)).map((row) => castRow<Purchase>("Purchase", row));
}

// flag_shih_tzu's scopes are `where("<condition>")`, which ActiveRecord wraps in parentheses again.
export const purchaseFlagScope = (name: Parameters<typeof PurchaseFlags.isSet>[1], enabled: boolean) => wrapped(PurchaseFlags.condition(name, enabled));

const present = (value: string | null | undefined) => value != null && value.trim() !== "";

const CROSS_BORDER_PAYOUTS_COUNTRIES: ReadonlySet<string> = new Set(SUBSCRIPTION_DATA.cross_border_payouts_countries);
const STRIPE = "stripe";

export type SubscriptionDeps = {
  // Time.current
  now: () => Date;
  // Feature.active?(name, seller)
  featureActive: (name: string, actor: FlipperActor | null) => Promise<boolean>;
};

export const defaultSubscriptionDeps: Pick<SubscriptionDeps, "featureActive"> = {
  featureActive: (name, actor) => isFeatureEnabled(name, actor),
};

export const INDIA_CARD_MANDATE_RELIABILITY_FEATURE = "india_card_mandate_reliability";
export const MEMBERSHIP_RENEWAL_REMINDERS_FEATURE = "membership_renewal_reminders";
const MERCHANT_MIGRATION_FEATURE = "merchant_migration";

export class SubscriptionRecord {
  row: Subscription;
  deps: SubscriptionDeps;
  memo: Map<string, Promise<unknown>>;

  constructor(row: Subscription, deps: SubscriptionDeps) {
    this.row = row;
    this.deps = deps;
    this.memo = new Map();
  }

  // An association loaded once per record, nil results included.
  loaded<T>(key: string, load: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = load();
      this.memo.set(key, value);
    }
    return value;
  }

  // An association a preload filled in.
  preload(key: string, value: unknown): void {
    this.memo.set(key, Promise.resolve(value));
  }

  get id(): bigint {
    return this.row.id;
  }

  flag(name: Parameters<typeof SubscriptionFlags.isSet>[1]): boolean {
    return SubscriptionFlags.isSet(this.row.flags, name);
  }

  get isTestSubscription(): boolean {
    return this.flag("is_test_subscription");
  }

  get renewalDisabledDueToIndianCardMandate(): boolean {
    return this.flag("renewal_disabled_due_to_indian_card_mandate");
  }

  // ----- associations

  link(): Promise<Link | null> {
    return this.loaded("link", () => findById<Link>("Link", this.row.link_id));
  }

  user(): Promise<User | null> {
    return this.loaded("user", () => findById<User>("User", this.row.user_id));
  }

  seller(): Promise<User | null> {
    return this.loaded("seller", () => findById<User>("User", this.row.seller_id));
  }

  lastPaymentOption(): Promise<PaymentOption | null> {
    return this.loaded("last_payment_option", () => findById<PaymentOption>("PaymentOption", this.row.last_payment_option_id));
  }

  // `has_one :original_purchase`, a scope on the flags.
  originalPurchase(): Promise<Purchase | null> {
    return this.loaded("original_purchase", async () => {
      const [row] = await selectRows(
        Prisma.sql`${SUBSCRIPTION_PURCHASES_SELECT} WHERE ${forSubscription(this.id)} AND ${purchaseFlagScope("is_original_subscription_purchase", true)} AND ${purchaseFlagScope("is_archived_original_subscription_purchase", false)} LIMIT 1`,
      );
      return row ? castRow<Purchase>("Purchase", row) : null;
    });
  }

  // ----- Feature flags and the seller's merchant account

  sellerActor(seller: User | null): FlipperActor | null {
    return seller === null ? null : userActor(seller.id);
  }

  // `Feature.active?(name, seller)`
  async featureActiveForSeller(name: string): Promise<boolean> {
    const seller = await this.seller();
    return this.deps.featureActive(name, this.sellerActor(seller));
  }

  // `seller.merchant_migration_enabled?` (User::FeatureStatus). A seller with compliance info needs
  // the country lists of Stripe Connect routing, which Node does not have.
  async merchantMigrationEnabled(seller: User): Promise<boolean> {
    if (UserFlags.isSet(seller.flags, "check_merchant_account_is_linked")) return true;
    if (!(await this.deps.featureActive(MERCHANT_MIGRATION_FEATURE, userActor(seller.id)))) return false;
    // `user_compliance_infos.alive.last`
    const [info] = await selectRows(
      Prisma.sql`SELECT ${star("user_compliance_info")} FROM ${table("user_compliance_info")} WHERE ${column("user_compliance_info", "user_id")} = ${seller.id} AND ${column("user_compliance_info", "deleted_at")} IS NULL ORDER BY ${column("user_compliance_info", "id")} DESC LIMIT 1`,
    );
    if (info === undefined) return false;
    throw new NotPortedError("User#stripe_connect_routing_country_code", "app/modules/user/feature_status.rb:23");
  }

  // `seller.stripe_connect_account`
  async stripeConnectAccount(seller: User): Promise<MerchantAccountRow | null> {
    return (await aliveStripeAccountsOf(seller.id)).find((account) => isStripeConnectAccount(account)) ?? null;
  }

  // `seller.merchant_account(stripe)`
  async sellerStripeMerchantAccount(seller: User): Promise<MerchantAccountRow | null> {
    const connected = (await this.merchantMigrationEnabled(seller)) && (await this.stripeConnectAccount(seller)) !== null;
    if (connected) return this.stripeConnectAccount(seller);
    // `find { can_accept_charges? && !is_a_stripe_connect_account? }`: a Gumroad-managed Stripe
    // account, whose country must be one Stripe accepts charges in.
    return (await aliveStripeAccountsOf(seller.id)).find((account) => !CROSS_BORDER_PAYOUTS_COUNTRIES.has(String(account.country)) && !isStripeConnectAccount(account)) ?? null;
  }

  // `renewal_merchant_account`: the seller's, else `MerchantAccount.gumroad(stripe)`.
  async renewalMerchantAccount(): Promise<MerchantAccountRow | null> {
    const seller = await this.seller();
    const own = seller === null ? null : await this.sellerStripeMerchantAccount(seller);
    if (own !== null) return own;
    const [row] = await selectRows(
      Prisma.sql`SELECT ${star("merchant_accounts")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
    );
    return row ? (castRow<MerchantAccount>("MerchantAccount", row) as unknown as MerchantAccountRow) : null;
  }

  // `india_card_mandate_reliability_enabled?`
  async indiaCardMandateReliabilityEnabled(): Promise<boolean> {
    const merchantAccount = await this.renewalMerchantAccount();
    if (!(await this.featureActiveForSeller(INDIA_CARD_MANDATE_RELIABILITY_FEATURE))) return false;
    const original = await this.originalPurchase();
    if (original !== null && PurchaseFlags.isSet(original.flags, "is_multi_buy")) return false;
    if (original !== null && (await this.orderHasMoreThanOnePurchase(original))) return false;
    return merchantAccount !== null && !isStripeConnectAccount(merchantAccount);
  }

  // `original_purchase&.order&.purchases&.many?`
  async orderHasMoreThanOnePurchase(original: Purchase): Promise<boolean> {
    const [order] = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${star("orders")} FROM ${table("orders")} INNER JOIN ${table("order_purchases")} ON ${column("orders", "id")} = ${column("order_purchases", "order_id")} WHERE ${column("order_purchases", "purchase_id")} = ${original.id} LIMIT 1`,
    );
    if (!order) return false;
    const [count] = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT COUNT(*) FROM (SELECT 1 AS one FROM ${table(PURCHASES)} INNER JOIN ${table("order_purchases")} ON ${column(PURCHASES, "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${order.id} LIMIT 2) subquery_for_count`,
    );
    return Number(count!["COUNT(*)"]) > 1;
  }

  // `indian_card_mandate_held?`
  indianCardMandateHeld(): boolean {
    return (
      this.flag("indian_card_mandate_hold_pending") &&
      this.renewalDisabledDueToIndianCardMandate &&
      !this.flag("indian_card_mandate_requires_reauthorization") &&
      present(this.row.stripe_mandate_id)
    );
  }

  // `send_renewal_reminders?`
  sendRenewalReminders(): Promise<boolean> {
    return this.featureActiveForSeller(MEMBERSHIP_RENEWAL_REMINDERS_FEATURE);
  }

  // ----- state

  now(): Date {
    return this.deps.now();
  }

  // `alive?(include_pending_cancellation:)`
  alive(includePendingCancellation = true): boolean {
    const { failed_at: failedAt, ended_at: endedAt, cancelled_at: cancelledAt } = this.row;
    if (failedAt != null || endedAt != null) return false;
    if (cancelledAt == null) return true;
    return includePendingCancellation && cancelledAt.getTime() > this.now().getTime();
  }

  hasFreeTrial(): boolean {
    return this.row.free_trial_ends_at != null;
  }

  // `in_free_trial?`
  inFreeTrial(): boolean {
    return this.hasFreeTrial() && this.row.free_trial_ends_at!.getTime() > this.now().getTime();
  }

  hasFixedLength(): boolean {
    return this.row.charge_occurrence_count != null;
  }

  // `charges_completed?`
  async chargesCompleted(): Promise<boolean> {
    return this.hasFixedLength() && (await this.successfulPurchasesCount()) === this.row.charge_occurrence_count;
  }

  // ----- recurrence

  // `price`: `(last_payment_option || fetch_last_payment_option).price`
  async price(): Promise<BasePrice | null> {
    const stored = await this.lastPaymentOption();
    if (stored !== null) return this.loaded(`price:${String(stored.id)}`, () => findById<BasePrice>("BasePrice", stored.price_id));
    // A freshly fetched option loads its own price each time.
    const fetched = await this.fetchLastPaymentOption();
    if (fetched === null) throw nilReceiver("price");
    return findById<BasePrice>("BasePrice", fetched.price_id);
  }

  // `payment_options.alive.last`
  async fetchLastPaymentOption(): Promise<PaymentOption | null> {
    const [row] = await selectRows(
      Prisma.sql`SELECT ${star("payment_options")} FROM ${table("payment_options")} WHERE ${column("payment_options", "subscription_id")} = ${this.id} AND ${column("payment_options", "deleted_at")} IS NULL ORDER BY ${column("payment_options", "id")} DESC LIMIT 1`,
    );
    return row ? castRow<PaymentOption>("PaymentOption", row) : null;
  }

  // `recurrence`
  async recurrence(): Promise<string | null> {
    if (!this.flag("is_installment_plan")) {
      const price = await this.price();
      if (price === null) throw nilReceiver("recurrence");
      return price.recurrence;
    }
    const option = await this.lastPaymentOption();
    const snapshot = option === null ? null : await this.loaded(`snapshot:${String(option.id)}`, () => findOneBy<InstallmentPlanSnapshot>("InstallmentPlanSnapshot", "payment_option_id", option.id));
    if (snapshot === null) {
      if (option === null) throw nilReceiver("installment_plan");
      const plan = await this.loaded(`plan:${String(option.id)}`, () => findById<ProductInstallmentPlan>("ProductInstallmentPlan", option.product_installment_plan_id));
      if (plan === null) throw nilReceiver("recurrence");
      return plan.recurrence;
    }
    return snapshot.recurrence;
  }

  // `period`
  async period(): Promise<Duration> {
    return periodOf(await this.recurrence());
  }

  // ----- purchases

  // `successful_purchases`
  successfulState(): string {
    return this.isTestSubscription ? "test_successful" : "successful";
  }

  async successfulPurchasesCount(): Promise<number> {
    const [row] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT COUNT(*) FROM ${table(PURCHASES)} WHERE ${forSubscription(this.id)} AND ${inState(this.successfulState())}`);
    return Number(row!["COUNT(*)"]);
  }

  // `successful_purchases.last`
  async lastSuccessfulCharge(): Promise<Purchase | null> {
    const [row] = await purchaseRows(Prisma.sql`${SUBSCRIPTION_PURCHASES_SELECT} WHERE ${forSubscription(this.id)} AND ${inState(this.successfulState())} ORDER BY ${column(PURCHASES, "id")} DESC LIMIT 1`);
    return row ?? null;
  }

  // `purchases.last`
  async lastPurchaseRow(): Promise<Purchase | null> {
    const [row] = await purchaseRows(Prisma.sql`${SUBSCRIPTION_PURCHASES_SELECT} WHERE ${forSubscription(this.id)} ORDER BY ${column(PURCHASES, "id")} DESC LIMIT 1`);
    return row ?? null;
  }

  // `purchases.is_free_trial_purchase.last`
  async lastFreeTrialPurchase(): Promise<Purchase | null> {
    const [row] = await purchaseRows(
      Prisma.sql`${SUBSCRIPTION_PURCHASES_SELECT} WHERE ${forSubscription(this.id)} AND ${purchaseFlagScope("is_free_trial_purchase", true)} ORDER BY ${column(PURCHASES, "id")} DESC LIMIT 1`,
    );
    return row ?? null;
  }

  // `last_successful_not_reversed_or_refunded_charge`
  async lastSuccessfulNotReversedOrRefundedCharge(): Promise<Purchase | null> {
    const [row] = await purchaseRows(
      Prisma.sql`${SUBSCRIPTION_PURCHASES_SELECT} WHERE ${forSubscription(this.id)} AND ${inState(this.successfulState())} AND ${NOT_FULLY_REFUNDED} AND ${NOT_CHARGEDBACK_OR_REVERSED} ORDER BY ${column(PURCHASES, "succeeded_at")} DESC LIMIT 1`,
    );
    return row ?? null;
  }

  // `has_a_charge_in_progress?`
  async hasAChargeInProgress(): Promise<boolean> {
    const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(PURCHASES)} WHERE ${forSubscription(this.id)} AND ${inState("in_progress")} LIMIT 1`);
    return rows.length > 0;
  }

  // `last_purchase`
  async lastPurchase(): Promise<Purchase | null> {
    return (await this.lastSuccessfulCharge()) ?? (await this.lastFreeTrialPurchase());
  }

  // `last_purchase_at`: `last_purchase&.succeeded_at || last_purchase&.created_at`
  async lastPurchaseAt(): Promise<Date | null> {
    return (await this.lastPurchase())?.succeeded_at ?? (await this.lastPurchase())?.created_at ?? null;
  }

  // `end_time_of_last_paid_period`
  async endTimeOfLastPaidPeriod(): Promise<Date | null> {
    if ((await this.lastSuccessfulNotReversedOrRefundedCharge())?.succeeded_at != null) {
      const succeededAt = (await this.lastSuccessfulNotReversedOrRefundedCharge())!.succeeded_at!;
      return advance(succeededAt, await this.period());
    }
    return this.row.free_trial_ends_at;
  }

  // `end_time_of_subscription`
  async endTimeOfSubscription(): Promise<Date> {
    if (this.row.free_trial_ends_at != null) {
      const last = await this.lastPurchase();
      if (last !== null && PurchaseFlags.isSet(last.flags, "is_free_trial_purchase")) return this.row.free_trial_ends_at;
    }
    if ((await this.endTimeOfLastPaidPeriod()) !== null && (await this.endTimeOfLastPaidPeriod())!.getTime() > this.now().getTime()) {
      return (await this.endTimeOfLastPaidPeriod())!;
    }
    const lastRow = await this.lastPurchaseRow();
    if (lastRow === null) throw nilReceiver("chargedback_not_reversed_or_refunded?");
    if (isChargedbackNotReversedOrRefunded(lastRow) || (await this.lastPurchaseAt()) === null) return this.now();
    return advance((await this.lastPurchaseAt())!, await this.period());
  }

  // `overdue_for_charge?`
  async overdueForCharge(): Promise<boolean> {
    return (await this.endTimeOfSubscription()).getTime() <= this.now().getTime();
  }

  // `seconds_overdue_for_charge`
  async secondsOverdueForCharge(): Promise<number> {
    if (!(await this.overdueForCharge()) || (await this.endTimeOfLastPaidPeriod()) === null) return 0;
    return Math.trunc((this.now().getTime() - (await this.endTimeOfLastPaidPeriod())!.getTime()) / 1000);
  }

  // ----- price

  // `current_subscription_price_cents` for a membership with no offer code anywhere near it. Any
  // discount, tier price or installment plan needs OfferCode and Purchase price logic that is not
  // ported, and raises NotPortedError (before the caller has written anything).
  async currentSubscriptionPriceCents(): Promise<number | null> {
    if (this.flag("is_installment_plan")) throw new NotPortedError("Subscription#current_subscription_price_cents for an installment plan", "subscription.rb:221");
    const original = await this.originalPurchase();
    if (original === null) throw nilReceiver("purchase_offer_code_discount");
    const discount = await this.loaded("original_discount", () => findOneBy<Record<string, unknown>>("PurchaseOfferCodeDiscount", "purchase_id", original.id));
    if (discount !== null || original.offer_code_id !== null) throw new NotPortedError("a subscription renewed with an offer code", "subscription.rb:1959");

    // compute_auto_renewal_offer_code(user): candidates are the product's and the seller's renewal-eligible codes.
    await this.user();
    const link = await this.link();
    if (link !== null) {
      const owner = await this.loaded("link_user", () => findById<User>("User", link.user_id));
      if (owner === null) throw nilReceiver("offer_codes");
      const productCodes = await selectRows(
        Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} INNER JOIN ${table("offer_codes_products")} ON ${column("offer_codes", "id")} = ${column("offer_codes_products", "offer_code_id")} WHERE ${column("offer_codes_products", "product_id")} = ${link.id} AND ${column("offer_codes", "deleted_at")} IS NULL AND (existing_customers_only = '1' OR JSON_LENGTH(ownership_duration_tiers) > 0)`,
      );
      const universalCodes = await selectRows(
        Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${owner.id} AND (universal = 1 and (currency_type = ${link.price_currency_type} or currency_type is null)) AND ${column("offer_codes", "deleted_at")} IS NULL AND (NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${String(link.id)})) AND (existing_customers_only = '1' OR JSON_LENGTH(ownership_duration_tiers) > 0)`,
      );
      if (productCodes.length + universalCodes.length > 0) throw new NotPortedError("a subscription whose product has renewal offer codes", "subscription.rb:1867");
    }
    return original.displayed_price_cents;
  }
}
