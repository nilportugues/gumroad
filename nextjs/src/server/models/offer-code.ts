// Read side of app/models/offer_code.rb: what Subscription#compute_auto_renewal_offer_code and
// Purchase#minimum_paid_price_cents ask of a code. Money is integer cents; a percentage is applied as
// Ruby does, in Float (`price * (percentage / 100.0)`) and rounded half away from zero. Nothing here
// writes a row.
//
// An `OfferCodeRecord` mirrors one loaded ActiveRecord object: an association is loaded once per
// record (`loaded`), and each call sends the statements the Ruby method does, in its order, whether
// or not their answer is used (`discount` loads the products only to list their external ids).
// Golden: worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json (the `price:` and
// `missing charge:` cases); the arithmetic: offer-code-pricing-vectors.golden.json.
import { Prisma, type BaseVariant, type Link, type OfferCode, type User, type VariantCategory } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { rubyRound, rubyToI } from "./concerns/ruby-numeric.ts";
import { advance } from "./concerns/ruby-time.ts";
import { findById } from "./row-reads.ts";
import { castRow, column, columnIn, quoteName, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const OFFER_CODES = "offer_codes";

export const OfferCodeFlags = defineFlags(
  OFFER_CODES,
  { 1: "is_cancellation_discount", 2: "created_via_cli", 3: "once_per_cart" },
  { queryMode: "bit_operator" },
);

const nullOperand = (method: string): never => {
  throw nilReceiver(method);
};

export const nilReceiver = (method: string, receiver = "nil") =>
  new TypeError(`undefined method '${method}' for ${receiver}`);

// ---------------------------------------------------------------------------------------------
// Arithmetic, on anything that carries the two amounts (a loaded code or the stub
// Purchase#original_offer_code builds from a cached discount).

export type Amounts = { amount_cents: number | null; amount_percentage: number | null };

// OfferCode#is_percent? / #is_cents?: `present?` of an Integer is "not nil", zero included.
export const isPercent = (code: Amounts): boolean => code.amount_percentage != null;
export const isCents = (code: Amounts): boolean => code.amount_cents != null;

// OfferCode#amount_off
export function amountOff(code: Amounts, priceCents: number | null): number {
  if (isCents(code)) return code.amount_cents!;
  if (code.amount_percentage == null) return 0;
  if (priceCents === null) throw nilReceiver("*");
  return rubyRound(priceCents * (code.amount_percentage / 100.0));
}

// OfferCode#original_price: nil for a 100% code, which cannot be reversed.
export function originalPrice(code: Amounts, discountedPriceCents: number | null): number | null {
  if (code.amount_percentage === 100) return null;
  if (isCents(code)) return (discountedPriceCents ?? nullOperand("+")) + code.amount_cents!;
  if (code.amount_percentage == null || discountedPriceCents === null) throw nilReceiver("/");
  return rubyRound(discountedPriceCents / (1 - code.amount_percentage / 100.0));
}

// OfferCode#months_since: whole calendar months from `timestamp` to `now`, never negative.
export function monthsSince(timestamp: Date | null, now: Date): number | null {
  if (timestamp === null) return null;
  let months =
    now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 - (timestamp.getUTCFullYear() * 12 + timestamp.getUTCMonth() + 1);
  if (advance(timestamp, { months }).getTime() > now.getTime()) months -= 1;
  return Math.max(months, 0);
}

export type Tier = { months: number; amount_percentage: number };

// OfferCode#tiered?: `ownership_duration_tiers.present?`. The column is a JSON document; an Array
// of tier Hashes is the only shape the validations let through.
export function tiersOf(raw: unknown): Record<string, unknown>[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed))
    throw new NotPortedError("ownership_duration_tiers that is not an Array", "offer_code.rb:436");
  for (const tier of parsed)
    if (tier === null || typeof tier !== "object" || Array.isArray(tier))
      throw new NotPortedError("a tier that is not a Hash", "offer_code.rb:442");
  return parsed as Record<string, unknown>[];
}

// OfferCode#normalized_ownership_duration_tiers
export function normalizeTiers(raw: Record<string, unknown>[]): Tier[] {
  const tiers = raw.map((tier) => ({
    months: rubyToI(tier.months),
    amount_percentage: rubyToI(tier.amount_percentage),
  }));
  // Array#sort_by is not stable; the validations keep each starting month unique.
  if (new Set(tiers.map((tier) => tier.months)).size !== tiers.length)
    throw new NotPortedError("tiers that start in the same month", "offer_code.rb:442");
  return tiers.sort((a, b) => a.months - b.months);
}

// OfferCode#matching_tier_for: the last tier that has started.
export const matchingTierFor = (tiers: Tier[], ownershipMonths: number): Tier | undefined =>
  [...tiers].reverse().find((tier) => tier.months <= ownershipMonths);

// ---------------------------------------------------------------------------------------------
// Statements

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);
const IN_PROGRESS = "in_progress";
// Purchase::NON_GIFT_SUCCESS_STATES
export const NON_GIFT_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged"];
// Purchase::ALL_SUCCESS_STATES
const ALL_SUCCESS_STATES = [...NON_GIFT_SUCCESS_STATES, "gift_receiver_purchase_successful"];
// ChargeProcessor::TIME_TO_COMPLETE_SCA
const TIME_TO_COMPLETE_SCA_MINUTES = 15;

export const states = (list: readonly string[]) =>
  Prisma.sql`${column("purchases", "purchase_state")} IN (${Prisma.join(list, ", ")})`;
export const purchaseFlag = (name: Parameters<typeof PurchaseFlags.isSet>[1], enabled: boolean) =>
  Prisma.sql`(${PurchaseFlags.condition(name, enabled)})`;
// Purchase.not_recurring_charge (not_subscription_or_original_purchase)
export const NOT_RECURRING_CHARGE = Prisma.raw(
  "(purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32')",
);
const NOT_FULLY_REFUNDED = Prisma.raw("(purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)");
const NOT_CHARGEDBACK_OR_REVERSED = Prisma.raw(
  "(purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0))",
);
const NOT_OWN_PURCHASE = Prisma.raw(
  "(purchases.purchaser_id IS NULL OR purchases.purchaser_id != purchases.seller_id)",
);
// OfferCode#qualifying_ownership_purchases
const QUALIFYING_OWNERSHIP_PURCHASES = Prisma.sql`${states(ALL_SUCCESS_STATES)} AND ${purchaseFlag("is_additional_contribution", false)} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_gift_sender_purchase", false)} AND ${NOT_FULLY_REFUNDED} AND ${NOT_CHARGEDBACK_OR_REVERSED} AND ${purchaseFlag("is_access_revoked", false)}`;
export const poc = (name: string) => column("purchase_offer_code_discounts", name);
const POC_JOIN = Prisma.sql`INNER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")}`;
const PAYMENT_INTENT_JOIN = Prisma.sql`LEFT OUTER JOIN ${table("processor_payment_intents")} ON ${column("processor_payment_intents", "purchase_id")} = ${column("purchases", "id")}`;
// Purchase.offer_code_statistics + .not_is_commission_completion_purchase (counts_towards_offer_code_uses)
export const countsTowardsUses = () =>
  Prisma.sql`${states(NON_GIFT_SUCCESS_STATES)} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)} AND ${purchaseFlag("is_commission_completion_purchase", false)}`;
// Purchase.completed_once_per_cart_allocation_uses, after the offer_code_id condition
const completedAllocationUses = () =>
  Prisma.sql`${states(NON_GIFT_SUCCESS_STATES)} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)} AND ${poc("once_per_cart")} = TRUE AND ${poc("once_per_cart_allocation_id")} IS NOT NULL AND ${NOT_OWN_PURCHASE}`;

async function count(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(sql);
  return Number(Object.values(row!)[0]);
}

// ---------------------------------------------------------------------------------------------

export type Discount = { type: "fixed"; cents: number | null } | { type: "percent"; percents: number | null };

export class OfferCodeRecord {
  row: OfferCode;
  memo: Map<string, Promise<unknown>>;

  constructor(row: OfferCode) {
    this.row = row;
    this.memo = new Map();
  }

  // An association loaded once per record, empty results included.
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

  get id(): number {
    return this.row.id;
  }

  // ActiveRecord::Core#==: the same class and a non-nil id.
  sameAs(other: OfferCodeRecord | null): boolean {
    return other !== null && other.id === this.id;
  }

  // Deletable#deleted?
  get deleted(): boolean {
    return this.row.deleted_at != null;
  }

  get oncePerCart(): boolean {
    return OfferCodeFlags.isSet(this.row.flags, "once_per_cart");
  }

  get tiers(): Record<string, unknown>[] {
    return tiersOf(this.row.ownership_duration_tiers);
  }

  tiered(): boolean {
    return this.tiers.length > 0;
  }

  // OfferCode#inactive?: not started yet, or past its end.
  inactive(now: Date): boolean {
    const { valid_at: validAt, expires_at: expiresAt } = this.row;
    return (
      (validAt != null && validAt.getTime() > now.getTime()) ||
      (expiresAt != null && expiresAt.getTime() < now.getTime())
    );
  }

  // ----- associations

  // `has_and_belongs_to_many :ownership_products`, as the preloader leaves it.
  ownershipProducts(): Promise<Link[]> {
    return this.loaded("ownership_products", async () =>
      (
        await selectRows(
          Prisma.sql`SELECT ${star("links")} FROM ${table("links")} INNER JOIN ${table("offer_codes_ownership_products")} ON ${column("links", "id")} = ${column("offer_codes_ownership_products", "product_id")} WHERE ${column("offer_codes_ownership_products", "offer_code_id")} = ${this.id}`,
        )
      ).map((row) => castRow<Link>("Link", row)),
    );
  }

  // `has_and_belongs_to_many :products`
  products(): Promise<Link[]> {
    return this.loaded("products", async () =>
      (
        await selectRows(
          Prisma.sql`SELECT ${star("links")} FROM ${table("links")} INNER JOIN ${table("offer_codes_products")} ON ${column("links", "id")} = ${column("offer_codes_products", "product_id")} WHERE ${column("offer_codes_products", "offer_code_id")} = ${this.id}`,
        )
      ).map((row) => castRow<Link>("Link", row)),
    );
  }

  // `has_and_belongs_to_many :excluded_products`
  excludedProducts(): Promise<Link[]> {
    return this.loaded("excluded_products", async () =>
      (
        await selectRows(
          Prisma.sql`SELECT ${star("links")} FROM ${table("links")} INNER JOIN ${table("offer_codes_excluded_products")} ON ${column("links", "id")} = ${column("offer_codes_excluded_products", "product_id")} WHERE ${column("offer_codes_excluded_products", "offer_code_id")} = ${this.id}`,
        )
      ).map((row) => castRow<Link>("Link", row)),
    );
  }

  private variantsJoin(): Prisma.Sql {
    return Prisma.sql`FROM ${table("base_variants")} INNER JOIN ${table("offer_codes_variants")} ON ${column("base_variants", "id")} = ${column("offer_codes_variants", "variant_id")} WHERE ${column("offer_codes_variants", "offer_code_id")} = ${this.id}`;
  }

  // `has_and_belongs_to_many :variants`
  variants(): Promise<VariantRecord[]> {
    return this.loaded("variants", async () =>
      (await selectRows(Prisma.sql`SELECT ${star("base_variants")} ${this.variantsJoin()}`)).map(
        (row) => new VariantRecord(castRow<BaseVariant>("BaseVariant", row)),
      ),
    );
  }

  // `variants.any?`: one existence query unless the association is already loaded.
  async hasVariants(): Promise<boolean> {
    if (this.memo.has("variants")) return (await this.variants()).length > 0;
    return (await selectRows(Prisma.sql`SELECT 1 AS one ${this.variantsJoin()} LIMIT 1`)).length > 0;
  }

  // ----- discount

  // OfferCode#discount, down to the statements it sends: it lists the external ids of the products
  // (or the excluded ones) and the options, though only `type` and the amount are read afterwards.
  async discount(): Promise<Discount> {
    const base: Discount = isCents(this.row)
      ? { type: "fixed", cents: this.row.amount_cents }
      : { type: "percent", percents: this.row.amount_percentage };
    if (this.row.universal) await this.excludedProducts();
    else await this.products();
    if (await this.hasVariants()) await this.optionIdsByProduct();
    return base;
  }

  // OfferCode#option_ids_by_product
  async optionIdsByProduct(): Promise<void> {
    // Grouping by product reads each option's category (`ObfuscateIds.encrypt(nil)` does not raise).
    for (const variant of await this.variants()) await variant.owningProductId();
  }

  // OfferCode#restricted_variants_for: the options the code is limited to on this product.
  async restrictedVariantsFor(product: Link): Promise<VariantRecord[]> {
    const restricted: VariantRecord[] = [];
    for (const variant of await this.variants())
      if (String(await variant.owningProductId()) === String(product.id)) restricted.push(variant);
    return restricted;
  }

  // ----- evaluation

  // OfferCode#ownership_reference_products
  async ownershipReferenceProducts(product: Link | null): Promise<Link[]> {
    // A row in offer_codes_ownership_variants counts only purchases of that option (#8969), which the months below do not read.
    const [optionRows] = await selectRows<{ found: number | bigint }>(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("offer_codes_ownership_variants")} WHERE ${column("offer_codes_ownership_variants", "offer_code_id")} = ${this.id}) AS found`,
    );
    if (Number(optionRows?.found ?? 0) > 0)
      throw new NotPortedError("OfferCode#ownership_variants", "offer_code.rb:464");
    const owned = await this.ownershipProducts();
    if (owned.length > 0) return owned;
    if (product !== null) return [product];
    throw new NotPortedError("OfferCode#applicable_products", "offer_code.rb:552");
  }

  // OfferCode#ownership_months_for: whole months since the buyer's oldest qualifying purchase of
  // these products, by account or (for a confirmed account) by email.
  async ownershipMonthsFor(buyer: User | null, products: Link[], now: Date): Promise<number | null> {
    if (buyer === null || products.length === 0) return null;
    const byAccount = Prisma.sql`purchases.purchaser_id = ${String(buyer.id)}`;
    const email = buyer.email;
    const hasEmail = email != null && email.trim() !== "";
    const condition =
      hasEmail && buyer.confirmed_at != null
        ? Prisma.sql`(${byAccount} OR purchases.email = ${email})`
        : Prisma.sql`(${byAccount})`;
    const [row] = await selectRows<{ created_at: Date | null }>(
      Prisma.sql`SELECT ${column("purchases", "created_at")} FROM ${table("purchases")} WHERE ${QUALIFYING_OWNERSHIP_PURCHASES} AND ${columnIn(
        "purchases",
        "link_id",
        products.map((product) => product.id),
      )} AND ${condition} ORDER BY ${column("purchases", "created_at")} ASC LIMIT 1`,
    );
    return monthsSince(row?.created_at ?? null, now);
  }

  // OfferCode#returning_customer?: a qualifying purchase from this seller by account, or by the checkout email.
  async returningCustomer(purchaserIds: (bigint | number | null)[], emails: (string | null)[]): Promise<boolean> {
    const ids = [...new Set(purchaserIds.filter((id): id is bigint | number => id !== null).map(String))];
    const addresses = [...new Set(emails.filter((email): email is string => email != null && email.trim() !== ""))];
    const exists = async (condition: Prisma.Sql) =>
      (
        await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table("purchases")} WHERE ${QUALIFYING_OWNERSHIP_PURCHASES} AND ${column("purchases", "seller_id")} = ${String(this.row.user_id)} AND ${condition} LIMIT 1`,
        )
      ).length > 0;
    return (
      (ids.length > 0 && (await exists(columnIn("purchases", "purchaser_id", ids)))) ||
      (addresses.length > 0 && (await exists(columnIn("purchases", "email", addresses))))
    );
  }

  // OfferCode#evaluate_for_buyer: the discount this code gives the buyer, or null.
  async evaluateForBuyer(
    buyer: User | null,
    product: Link,
    fallbackCreatedAt: Date | null,
    now: Date,
  ): Promise<Discount | null> {
    const reference = await this.ownershipReferenceProducts(product);
    const tiered = this.tiered();
    let months: number | null = null;
    if (this.row.existing_customers_only || tiered) months = await this.ownershipMonthsFor(buyer, reference, now);
    if (this.row.existing_customers_only && months === null) return null;

    if (tiered) {
      months ??= monthsSince(fallbackCreatedAt, now);
      const tier = matchingTierFor(normalizeTiers(this.tiers), months ?? 0);
      if (tier === undefined) return null;
      await this.discount();
      return { type: "percent", percents: tier.amount_percentage };
    }
    return this.discount();
  }

  // ----- usage limits

  // OfferCode#times_used
  async timesUsed(): Promise<number> {
    const perItem = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT SUM(${column("purchases", "quantity")}) FROM ${table("purchases")} LEFT OUTER JOIN ${table("purchase_offer_code_discounts")} ON ${poc("purchase_id")} = ${column("purchases", "id")} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${countsTowardsUses()} AND (${poc("once_per_cart")} = FALSE OR ${poc("once_per_cart")} IS NULL)`,
    );
    const legacyPerCart = await count(
      Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} ${POC_JOIN} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${countsTowardsUses()} AND ${poc("once_per_cart")} = TRUE AND ${poc("once_per_cart_allocation_id")} IS NULL`,
    );
    const allocationUses = await count(
      Prisma.sql`SELECT COUNT(DISTINCT ${poc("once_per_cart_allocation_id")}) FROM ${table("purchases")} ${POC_JOIN} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${completedAllocationUses()}`,
    );
    return Number(Object.values(perItem[0]!)[0] ?? 0) + legacyPerCart + allocationUses;
  }

  // OfferCode#active_once_per_cart_reservations
  async activeOncePerCartReservations(now: Date): Promise<number> {
    const cutoff = advance(now, { minutes: -TIME_TO_COMPLETE_SCA_MINUTES });
    const unconfirmed = Prisma.sql`(purchases.created_at >= ${cutoff} OR purchases.stripe_status IS NOT NULL OR purchases.processor_setup_intent_id IS NOT NULL OR processor_payment_intents.id IS NOT NULL)`;
    const legacy = await count(
      Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} ${POC_JOIN} ${PAYMENT_INTENT_JOIN} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${column("purchases", "purchase_state")} = ${IN_PROGRESS} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_additional_contribution", false)} AND ${purchaseFlag("is_gift_receiver_purchase", false)} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)} AND ${purchaseFlag("is_commission_completion_purchase", false)} AND ${poc("once_per_cart")} = TRUE AND ${NOT_OWN_PURCHASE} AND (purchases.preorder_id IS NULL OR purchases.flags & ${String(PurchaseFlags.bit("is_preorder_authorization"))} != 0) AND ${unconfirmed} AND ${poc("once_per_cart_allocation_id")} IS NULL`,
    );
    const allocations = await count(
      Prisma.sql`SELECT COUNT(DISTINCT ${poc("once_per_cart_allocation_id")}) FROM ${table("purchases")} ${POC_JOIN} ${PAYMENT_INTENT_JOIN} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${column("purchases", "purchase_state")} = ${IN_PROGRESS} AND ${poc("once_per_cart")} = TRUE AND ${poc("once_per_cart_allocation_id")} IS NOT NULL AND ${NOT_OWN_PURCHASE} AND ${unconfirmed} AND ${poc("once_per_cart_allocation_id")} NOT IN (SELECT ${poc("once_per_cart_allocation_id")} FROM ${table("purchases")} ${POC_JOIN} WHERE ${column("purchases", "offer_code_id")} = ${this.id} AND ${completedAllocationUses()})`,
    );
    return legacy + allocations;
  }

  // OfferCode#quantity_left
  async quantityLeft(now: Date): Promise<number> {
    return this.row.max_purchase_count! - (await this.timesUsed()) - (await this.activeOncePerCartReservations(now));
  }

  // OfferCode#is_valid_for_purchase?
  async isValidForPurchase(purchaseQuantity: number, now: Date): Promise<boolean> {
    if (this.row.max_purchase_count == null) return true;
    return (await this.quantityLeft(now)) >= (isCents(this.row) && this.oncePerCart ? 1 : purchaseQuantity);
  }
}

// A BaseVariant row: a Variant reaches its product through its category, a Sku carries it.
export class VariantRecord {
  row: BaseVariant;
  memo: Map<string, Promise<unknown>>;

  constructor(row: BaseVariant) {
    this.row = row;
    this.memo = new Map();
  }

  get isVariant(): boolean {
    return this.row.type === "Variant";
  }

  // BaseVariant#owning_product_id
  async owningProductId(): Promise<bigint | number | null> {
    if (!this.isVariant) return this.row.link_id;
    let category = this.memo.get("variant_category") as Promise<VariantCategory | null> | undefined;
    if (category === undefined) {
      category = findById<VariantCategory>("VariantCategory", this.row.variant_category_id);
      this.memo.set("variant_category", category);
    }
    return (await category)?.link_id ?? null;
  }
}

// OfferCode#applicable_to_variants?: every picked option in a category the code limits is one it
// is limited to. `picked` are the purchase's options (BaseVariant rows).
export async function applicableToVariants(
  code: OfferCodeRecord,
  product: Link,
  picked: () => Promise<VariantRecord[]>,
): Promise<boolean> {
  const restricted = await code.restrictedVariantsFor(product);
  if (restricted.length === 0) return true;

  const restrictedIds = restricted.map((variant) => String(variant.row.id));
  const restrictedCategoryIds = new Set(restricted.map((variant) => String(variant.row.variant_category_id)));
  const scoped = (await picked()).filter((variant) =>
    restrictedCategoryIds.has(String(variant.row.variant_category_id)),
  );
  return scoped.length > 0 && scoped.every((variant) => restrictedIds.includes(String(variant.row.id)));
}
