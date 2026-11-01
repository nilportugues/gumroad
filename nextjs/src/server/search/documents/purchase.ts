// Purchase::Searchable#search_field_value and the purchase.rb / subscription.rb / user.rb /
// affiliate_credit.rb / link.rb reads it makes, statement for statement: an association is read
// once per record (ActiveRecord caches it), a relation (`sum`, `pluck`, `ids`) on every call.
import { Prisma } from "@prisma/client";

import type { Row } from "../../models/runtime/record.ts";
import { selectRows } from "../../models/sql.ts";
import { type JsonValue, RubyFloat } from "../es-json.ts";
import { PURCHASE_FLAG_MAPPING, PurchaseFlags, selectedFlags } from "../flags.ts";
import { plaintextDescription } from "../plaintext.ts";
import { extractDomain } from "../referrer.ts";
import { attributeAsJson, col, findById, findOneWhere, isBlank, presence, q, rubySplit, sumOf } from "../rows.ts";

export const REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS = "recommended_by_gumroad";
const CARD_TYPE_PAYPAL = "paypal";

// BasePrice::Recurrence::RECURRENCE_TO_NUMBER_OF_MONTHS
const RECURRENCE_TO_NUMBER_OF_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24 };

// `mappings.to_hash[:properties].keys`: the order as_indexed_json writes the fields in.
export const PURCHASE_SEARCH_FIELDS = [
  "id", "can_contact", "chargeback_date", "country_or_ip_country", "created_at", "latest_charge_date", "email", "email_domain",
  "subscription_current_email", "subscription_current_email_domain", "paypal_email", "fee_cents", "full_name",
  "not_chargedback_or_chargedback_reversed", "not_refunded_except_subscriptions", "not_subscription_or_original_subscription_purchase",
  "successful_authorization_or_without_preorder", "price_cents", "purchase_state", "amount_refunded_cents", "fee_refunded_cents",
  "tax_refunded_cents", "selected_flags", "stripe_refunded", "tax_cents", "monthly_recurring_revenue", "ip_country", "ip_state",
  "referrer_domain", "license_serial", "license_uses", "variant_ids", "product_ids_from_same_seller_purchased_by_purchaser",
  "variant_ids_from_same_seller_purchased_by_purchaser", "affiliate_credit_id", "affiliate_credit_affiliate_user_id",
  "affiliate_credit_amount_cents", "affiliate_credit_fee_cents", "affiliate_credit_amount_partially_refunded_cents",
  "affiliate_credit_fee_partially_refunded_cents", "direct_affiliate_credit_affiliate_user_id", "direct_affiliate_credit_amount_cents",
  "direct_affiliate_credit_fee_cents", "direct_affiliate_credit_amount_partially_refunded_cents",
  "direct_affiliate_credit_fee_partially_refunded_cents", "product_id", "product_unique_permalink", "product_name", "product_description",
  "seller_id", "seller_name", "purchaser_id", "subscription_id", "subscription_cancelled_at", "subscription_deactivated_at", "taxonomy_id",
] as const;

// Purchase::Searchable::ATTRIBUTE_TO_SEARCH_FIELDS
export const PURCHASE_ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string | string[]> = {
  id: "id",
  can_contact: "can_contact",
  chargeback_date: ["chargeback_date", "not_chargedback_or_chargedback_reversed"],
  country: "country_or_ip_country",
  created_at: "created_at",
  email: ["email", "email_domain", "subscription_current_email", "subscription_current_email_domain"],
  fee_cents: "fee_cents",
  flags: ["selected_flags", "not_chargedback_or_chargedback_reversed", "not_subscription_or_original_subscription_purchase", "referrer_domain"],
  full_name: "full_name",
  ip_country: ["country_or_ip_country", "ip_country"],
  ip_state: "ip_state",
  referrer: "referrer_domain",
  price_cents: "price_cents",
  purchase_state: ["purchase_state", "latest_charge_date", "successful_authorization_or_without_preorder"],
  stripe_refunded: ["stripe_refunded", "not_refunded_except_subscriptions"],
  tax_cents: "tax_cents",
  card_visual: "paypal_email",
  subscription_id: "subscription_id",
  license_serial: "license_serial",
  license_uses: "license_uses",
  purchaser_id: "purchaser_id",
};

const REFUNDS_EFFECTIVE =
  "(refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')";

// NoMethodError on nil, as Ruby raises it.
export class RubyNoMethodError extends Error {
  constructor(method: string) {
    super(`undefined method '${method}' for nil`);
    this.name = "NoMethodError";
  }
}

const lower = (value: unknown) => (value === null || value === undefined ? null : String(value).toLowerCase());

class Memo<T> {
  private loaded = false;
  private value: T | undefined;
  private readonly load: () => Promise<T>;
  constructor(load: () => Promise<T>) {
    this.load = load;
  }
  async get(): Promise<T> {
    if (!this.loaded) {
      this.value = await this.load();
      this.loaded = true;
    }
    return this.value as T;
  }
}

// A loaded purchases row with the associations Purchase::Searchable reads.
export class PurchaseRecord {
  readonly row: Row;
  private readonly subscriptionMemo: Memo<SubscriptionRecord | null>;
  private readonly linkMemo: Memo<Row | null>;
  private readonly sellerMemo: Memo<Row | null>;
  private readonly purchaserMemo: Memo<Row | null>;
  private readonly licenseMemo: Memo<Row | null>;
  private readonly affiliateCreditMemo: Memo<Row | null>;
  private readonly directAffiliateCreditMemo: Memo<Row | null>;
  private readonly giftGivenMemo: Memo<Row | null>;
  giftGiven = () => this.giftGivenMemo.get();

  // `subscription`: the record that loaded this one through has_one :original_purchase, which
  // ActiveRecord sets as the inverse belongs_to (automatic_scope_inversing).
  constructor(row: Row, loadedBy?: SubscriptionRecord) {
    this.row = row;
    const id = row.id;
    const belongsTo = (model: Prisma.ModelName, table: string, key: string) => new Memo(async () => (row[key] == null ? null : findById(model, table, row[key])));
    this.subscriptionMemo = new Memo(async () => {
      if (loadedBy) return loadedBy;
      const subscription = row.subscription_id == null ? null : await findById("Subscription", "subscriptions", row.subscription_id);
      return subscription ? new SubscriptionRecord(subscription) : null;
    });
    this.linkMemo = belongsTo("Link", "links", "link_id");
    this.sellerMemo = belongsTo("User", "users", "seller_id");
    this.purchaserMemo = belongsTo("User", "users", "purchaser_id");
    this.licenseMemo = new Memo(() => findOneWhere("License", "licenses", Prisma.sql`${col("licenses", "purchase_id")} = ${id}`));
    const credit = (direct: boolean) =>
      new Memo(() =>
        findOneWhere(
          "AffiliateCredit",
          "affiliate_credits",
          Prisma.sql`${col("affiliate_credits", "purchase_id")} = ${id} AND ${col("affiliate_credits", "is_direct_affiliate_credit")} = ${Prisma.raw(direct ? "TRUE" : "FALSE")}`,
        ),
      );
    this.affiliateCreditMemo = credit(false);
    this.directAffiliateCreditMemo = credit(true);
    this.giftGivenMemo = new Memo(() => findOneWhere("Gift", "gifts", Prisma.sql`${col("gifts", "gifter_purchase_id")} = ${id}`));
  }

  static async find(id: unknown): Promise<PurchaseRecord | null> {
    const row = await findById("Purchase", "purchases", id);
    return row ? new PurchaseRecord(row) : null;
  }

  get = (name: string): unknown => this.row[name];
  flag = (name: (typeof PURCHASE_FLAG_MAPPING)[keyof typeof PURCHASE_FLAG_MAPPING]): boolean => PurchaseFlags.isSet(this.row.flags as bigint, name);

  subscription = () => this.subscriptionMemo.get();
  link = () => this.linkMemo.get();
  seller = () => this.sellerMemo.get();
  purchaser = () => this.purchaserMemo.get();
  affiliateCredit = () => this.affiliateCreditMemo.get();
  directAffiliateCredit = () => this.directAffiliateCreditMemo.get();

  // Purchase#is_recurring_subscription_charge
  async isRecurringSubscriptionCharge(): Promise<boolean> {
    return (await this.subscription()) !== null && !this.flag("is_original_subscription_purchase") && !this.flag("is_gift_receiver_purchase");
  }

  // Purchase#license
  async license(): Promise<Row | null> {
    if (await this.isRecurringSubscriptionCharge()) {
      const original = await (await this.subscription())!.originalPurchase();
      if (!original) throw new RubyNoMethodError("license");
      return original.license();
    }
    return this.licenseMemo.get();
  }

  private refundsSum(column: string): Promise<number> {
    return sumOf(Prisma.sql`SELECT SUM(${col("refunds", column)}) FROM ${Prisma.raw(q("refunds"))} WHERE ${col("refunds", "purchase_id")} = ${this.row.id} AND ${Prisma.raw(REFUNDS_EFFECTIVE)}`);
  }

  // Purchase#by_email relation: `where(email:)`, `IS NULL` for nil.
  private byEmailSql(sellerId: unknown): Prisma.Sql {
    const email = this.row.email;
    return Prisma.sql`${col("purchases", "seller_id")} = ${sellerId} AND ${email == null ? Prisma.sql`${col("purchases", "email")} IS NULL` : Prisma.sql`${col("purchases", "email")} = ${email}`}`;
  }

  async searchFieldValue(field: string): Promise<JsonValue> {
    const row = this.row;
    let match: RegExpExecArray | null;
    switch (field) {
      case "id": case "can_contact": case "created_at": case "full_name": case "price_cents": case "chargeback_date":
      case "purchase_state": case "ip_country": case "ip_state": case "fee_cents": case "tax_cents":
        return attributeAsJson(row[field]);
      case "email":
        return lower(row.email);
      case "email_domain":
        return isBlank(row.email) ? null : (rubySplit(String(row.email).toLowerCase(), "@")[1] ?? null);
      case "subscription_current_email": {
        if (!this.flag("is_original_subscription_purchase")) return null;
        const subscription = await this.subscription();
        if (!subscription) return null;
        return lower(await subscription.email());
      }
      case "subscription_current_email_domain": {
        if (!this.flag("is_original_subscription_purchase")) return null;
        const subscription = await this.subscription();
        if (!subscription || isBlank(await subscription.email())) return null;
        return rubySplit(String(await subscription.email()).toLowerCase(), "@")[1] ?? null;
      }
      case "selected_flags":
        return selectedFlags(PURCHASE_FLAG_MAPPING, row.flags as bigint);
      case "stripe_refunded":
        return row.stripe_refunded === true;
      case "not_chargedback_or_chargedback_reversed":
        return row.chargeback_date == null || this.flag("chargeback_reversed");
      case "not_refunded_except_subscriptions":
        return row.stripe_refunded !== true || (row.subscription_id != null && BigInt(row.subscription_id as bigint) !== 0n);
      case "not_subscription_or_original_subscription_purchase":
        return row.subscription_id == null || (this.flag("is_original_subscription_purchase") && !this.flag("is_archived_original_subscription_purchase"));
      case "successful_authorization_or_without_preorder":
        return ["preorder_authorization_successful", "preorder_concluded_successfully"].includes(String(row.purchase_state)) || row.preorder_id == null;
      case "country_or_ip_country":
        return (presence(row.country) ?? row.ip_country ?? null) as JsonValue;
      case "amount_refunded_cents":
        return this.refundsSum("amount_cents");
      case "fee_refunded_cents":
        return this.refundsSum("fee_cents");
      case "tax_refunded_cents":
        return this.refundsSum("creator_tax_cents");
      case "referrer_domain":
        return this.flag("was_product_recommended") ? REFERRER_DOMAIN_FOR_GUMROAD_RECOMMENDED_PRODUCTS : extractDomain(row.referrer as string | null);
      case "product_description": {
        const link = await this.link();
        if (!link) throw new RubyNoMethodError("plaintext_description");
        return plaintextDescription(link.description as string | null);
      }
      case "taxonomy_id": {
        const link = await this.link();
        if (!link) throw new RubyNoMethodError("taxonomy_id");
        return attributeAsJson(link.taxonomy_id);
      }
      case "variant_ids": {
        const rows = await selectRows<{ id: unknown }>(
          Prisma.sql`SELECT ${col("base_variants", "id")} FROM ${Prisma.raw(q("base_variants"))} INNER JOIN ${Prisma.raw(q("base_variants_purchases"))} ON ${col("base_variants", "id")} = ${col("base_variants_purchases", "base_variant_id")} WHERE ${col("base_variants_purchases", "purchase_id")} = ${row.id}`,
        );
        return rows.map((r) => attributeAsJson(BigInt(r.id as bigint)));
      }
      case "product_ids_from_same_seller_purchased_by_purchaser": {
        const seller = await this.seller();
        if (!seller) throw new RubyNoMethodError("sales");
        const rows = await selectRows<{ link_id: unknown }>(Prisma.sql`SELECT distinct link_id FROM ${Prisma.raw(q("purchases"))} WHERE ${this.byEmailSql(seller.id)}`);
        return rows.map((r) => (r.link_id == null ? null : BigInt(r.link_id as bigint)));
      }
      case "variant_ids_from_same_seller_purchased_by_purchaser": {
        const seller = await this.seller();
        if (!seller) throw new RubyNoMethodError("sales");
        const purchasesSql = Prisma.sql`SELECT ${col("purchases", "id")} FROM ${Prisma.raw(q("purchases"))} WHERE ${this.byEmailSql(seller.id)}`;
        const rows = await selectRows<Record<string, unknown>>(
          Prisma.sql`select distinct base_variant_id from base_variants_purchases\nwhere purchase_id IN (${purchasesSql})\n`,
        );
        return rows.map((r) => {
          const value = Object.values(r)[0];
          return value == null ? null : BigInt(value as bigint);
        });
      }
      case "latest_charge_date": {
        if (!this.flag("is_original_subscription_purchase")) return null;
        const subscription = await this.subscription();
        if (!subscription) return null;
        const [latest] = await selectRows<{ created_at: unknown }>(
          Prisma.sql`SELECT ${Prisma.raw(q("created_at"))} FROM ${Prisma.raw(q("purchases"))} FORCE INDEX(${Prisma.raw(q("index_purchases_on_subscription_id"))}) WHERE ${col("purchases", "subscription_id")} = ${subscription.row.id} AND ${col("purchases", "purchase_state")} = 'successful' ORDER BY ${Prisma.raw(q("created_at"))} DESC, ${Prisma.raw(q("id"))} DESC LIMIT 1`,
        );
        if (!latest || latest.created_at == null) return null;
        return attributeAsJson(latest.created_at instanceof Date ? latest.created_at : new Date(String(latest.created_at)));
      }
      case "monthly_recurring_revenue": {
        if (!this.flag("is_original_subscription_purchase")) return null;
        const subscription = await this.subscription();
        const recurrence = subscription ? await subscription.lastPaymentOptionRecurrence() : null;
        if (isBlankRecurrence(recurrence)) return null;
        const months = RECURRENCE_TO_NUMBER_OF_MONTHS[String(recurrence)];
        if (months === undefined) throw new TypeError("nil can't be coerced into Float");
        return new RubyFloat(Number(row.price_cents ?? 0) / months);
      }
      case "paypal_email":
        return row.card_type === CARD_TYPE_PAYPAL ? lower(row.card_visual) : null;
      case "license_serial": {
        const license = await this.license();
        return license ? attributeAsJson(license.serial) : null;
      }
      case "license_uses": {
        const license = await this.license();
        return license ? attributeAsJson(license.uses) : null;
      }
    }
    if ((match = /^affiliate_credit_(id|affiliate_user_id|amount_cents|fee_cents|amount_partially_refunded_cents|fee_partially_refunded_cents)$/u.exec(field))) {
      return creditValue(await this.affiliateCredit(), match[1]!);
    }
    if ((match = /^direct_affiliate_credit_(affiliate_user_id|amount_cents|fee_cents|amount_partially_refunded_cents|fee_partially_refunded_cents)$/u.exec(field))) {
      return creditValue(await this.directAffiliateCredit(), match[1]!);
    }
    if ((match = /^product_(id|unique_permalink|name)$/u.exec(field))) {
      const link = await this.link();
      if (!link) throw new RubyNoMethodError("attributes");
      return attributeAsJson(link[match[1]!]);
    }
    if ((match = /^seller_(id|name)$/u.exec(field))) {
      const seller = await this.seller();
      if (!seller) throw new RubyNoMethodError("attributes");
      return attributeAsJson(seller[match[1]!]);
    }
    if (field === "purchaser_id") {
      const purchaser = await this.purchaser();
      return purchaser ? attributeAsJson(purchaser.id) : null;
    }
    if ((match = /^subscription_(id|cancelled_at|deactivated_at)$/u.exec(field))) {
      const subscription = await this.subscription();
      return subscription ? attributeAsJson(subscription.row[match[1]!]) : null;
    }
    return null;
  }

  // SearchIndexModelCommon#as_indexed_json(only:)
  async asIndexedJson(only?: readonly string[]): Promise<Record<string, JsonValue>> {
    const document: Record<string, JsonValue> = {};
    for (const field of only ?? PURCHASE_SEARCH_FIELDS) document[field] = await this.searchFieldValue(field);
    return document;
  }
}

// `recurrence` truthiness in `subscription&.last_payment_option&.price&.recurrence`.
const isBlankRecurrence = (value: unknown) => value === null || value === undefined;

async function creditValue(credit: Row | null, attribute: string): Promise<JsonValue> {
  if (!credit) return null;
  if (attribute === "amount_partially_refunded_cents" || attribute === "fee_partially_refunded_cents") {
    const column = attribute === "amount_partially_refunded_cents" ? "amount_cents" : "fee_cents";
    return sumOf(
      Prisma.sql`SELECT SUM(${col("affiliate_partial_refunds", column)}) FROM ${Prisma.raw(q("affiliate_partial_refunds"))} WHERE ${col("affiliate_partial_refunds", "affiliate_credit_id")} = ${credit.id}`,
    );
  }
  return attributeAsJson(credit[attribute]);
}

// The subscription.rb side: Subscription#email and the payment option's price.
export class SubscriptionRecord {
  readonly row: Row;
  private readonly userMemo: Memo<Row | null>;
  private readonly originalPurchaseMemo: Memo<PurchaseRecord | null>;
  private readonly trueOriginalPurchaseMemo: Memo<PurchaseRecord | null>;
  private readonly lastPaymentOptionMemo: Memo<Row | null>;
  private readonly priceMemos = new Map<string, Memo<Row | null>>();

  constructor(row: Row) {
    this.row = row;
    this.userMemo = new Memo(async () => (row.user_id == null ? null : findById("User", "users", row.user_id)));
    const original = (suffix: Prisma.Sql, archived: boolean) =>
      new Memo(async () => {
        // Scope conditions come wrapped in their own parentheses.
        const scoped = (sql: Prisma.Sql) => Prisma.sql`(${sql})`;
        const conditions = [Prisma.sql`${col("purchases", "subscription_id")} = ${row.id}`, scoped(PurchaseFlags.condition("is_original_subscription_purchase"))];
        if (archived) conditions.push(scoped(PurchaseFlags.condition("is_archived_original_subscription_purchase", false)));
        const found = await findOneWhere("Purchase", "purchases", Prisma.join(conditions, " AND "), suffix);
        return found ? new PurchaseRecord(found, this) : null;
      });
    this.originalPurchaseMemo = original(Prisma.empty, true);
    this.trueOriginalPurchaseMemo = original(Prisma.sql` ORDER BY ${col("purchases", "id")} ASC`, false);
    this.lastPaymentOptionMemo = new Memo(async () => (row.last_payment_option_id == null ? null : findById("PaymentOption", "payment_options", row.last_payment_option_id)));
  }

  originalPurchase = () => this.originalPurchaseMemo.get();

  // Subscription#email: `user&.form_email.presence || (gift? ? true_original_purchase.giftee_email : original_purchase.email)`
  async email(): Promise<string | null> {
    const user = await this.userMemo.get();
    const formEmail = user ? (presence(user.unconfirmed_email) ?? presence(user.email)) : null;
    if (presence(formEmail)) return formEmail as string;
    const trueOriginal = await this.trueOriginalPurchaseMemo.get();
    if (!trueOriginal) throw new RubyNoMethodError("is_gift_sender_purchase?");
    if (trueOriginal.flag("is_gift_sender_purchase")) {
      // Purchase#giftee_email: `gift&.giftee_email`, the sender's has_one :gift_given.
      const gift = await trueOriginal.giftGiven();
      return gift ? ((gift.giftee_email as string | null) ?? null) : null;
    }
    const original = await this.originalPurchaseMemo.get();
    if (!original) throw new RubyNoMethodError("email");
    return (original.row.email as string | null) ?? null;
  }

  // `last_payment_option&.price&.recurrence`
  async lastPaymentOptionRecurrence(): Promise<unknown> {
    const option = await this.lastPaymentOptionMemo.get();
    if (!option) return null;
    const key = String(option.price_id);
    if (!this.priceMemos.has(key)) this.priceMemos.set(key, new Memo(async () => (option.price_id == null ? null : findById("BasePrice", "prices", option.price_id))));
    const price = await this.priceMemos.get(key)!.get();
    return price ? price.recurrence : null;
  }
}
