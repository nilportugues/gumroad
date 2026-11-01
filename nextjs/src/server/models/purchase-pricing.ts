// The price readers of app/models/purchase.rb that a subscription's renewal price needs:
// `minimum_paid_price_cents` (the instalment amount of an installment plan),
// `displayed_price_cents_before_offer_code`, `minimum_paid_price_cents_per_unit_before_discount`
// and the offer code a purchase is priced with. Integer cents throughout; the Float steps
// (a percentage, a commission deposit) are Ruby's and round half away from zero.
//
// A `PurchaseRecord` mirrors one loaded ActiveRecord object: an association is loaded once per
// record, and each method sends the statements the Ruby method does, in order. Nothing here writes.
// Golden: worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json (the `price:` and
// `missing charge:` cases); the arithmetic: offer-code-pricing-vectors.golden.json.
import { Prisma, type BaseVariant, type BasePrice, type InstallmentPlanSnapshot, type License, type Link, type OfferCode, type ProductInstallmentPlan, type Purchase, type PurchaseOfferCodeDiscount, type Subscription, type Tip, type User } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import LINK_DATA from "./link-data.generated.json" with { type: "json" };
import { rubyRound, rubyToI } from "./concerns/ruby-numeric.ts";
import { amountOff, applicableToVariants, isCents, nilReceiver, OfferCodeFlags, OfferCodeRecord, originalPrice, VariantRecord, type Amounts } from "./offer-code.ts";
import { PurchaseFlags } from "../search/flags.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { PURCHASES } from "./purchase.ts";
import { castRow, column, quoteName, selectRows, table } from "./sql.ts";
import type { SubscriptionRecord } from "./subscription.ts";
import { NotPortedError, UserFlags } from "./user.ts";

const CURRENCIES = LINK_DATA.currencies as Record<string, { min_price: number; single_unit: boolean }>;
// Commission::COMMISSION_DEPOSIT_PROPORTION
export const COMMISSION_DEPOSIT_PROPORTION = 0.5;
const NATIVE_TYPE_COMMISSION = "commission";

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);
// BasePrice.is_buy (not_is_rental, flag_shih_tzu's bit_operator scope)
const PriceFlags = defineFlags("prices", { 1: "is_rental" }, { queryMode: "bit_operator" });

// The two Link flags a price reads (link.ts has the whole mapping, and the model runtime with it).
const LinkFlags = defineFlags("links", { 19: "is_tiered_membership", 27: "purchasing_power_parity_disabled" }, { queryMode: "bit_operator" });

const nullOperand = (method: string): never => {
  throw nilReceiver(method);
};

// `link.currency["min_price"]`: CURRENCY_CHOICES has no entry for an unknown currency.
export function currencyMinPrice(link: Pick<Link, "price_currency_type">): number {
  const currency = link.price_currency_type === null ? undefined : CURRENCIES[link.price_currency_type];
  if (currency === undefined) throw nilReceiver("[]");
  return currency.min_price;
}

// `subscription.purchases.successful.count` (a test subscription is not special-cased by the scope)
export async function successfulPurchasesCount(subscriptionId: bigint): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "subscription_id")} = ${subscriptionId} AND ${column(PURCHASES, "purchase_state")} = ${"successful"}`,
  );
  return Number(row!["COUNT(*)"]);
}

// Subscription#renewal_purchase_quantity (`quantity || 1`)
export const quantityOf = (purchase: Pick<Purchase, "quantity">): number => purchase.quantity ?? 1;

// ProductInstallmentPlan#calculate_installment_payment_price_cents and the snapshot's: the total
// split evenly, the remainder on the first payment.
export function installmentPayments(totalPriceCents: number, numberOfInstallments: number): number[] {
  const base = Math.floor(totalPriceCents / numberOfInstallments);
  const remainder = ((totalPriceCents % numberOfInstallments) + numberOfInstallments) % numberOfInstallments;
  return Array.from({ length: numberOfInstallments }, (_, i) => (i === 0 ? base + remainder : base));
}

// `installment_payments[nth] || installment_payments.last`
export const installmentPaymentAt = (payments: number[], nth: number): number | undefined => payments[nth] ?? payments.at(-1);

// Purchase#fetch_installment_payments_from_snapshot_or_plan, then `[nth] || last`: the instalment of
// the nth charge, from the snapshot of the plan the buyer signed up to or, without one, the
// product's plan split over the total.
export function installmentPaymentFor(input: {
  totalPriceCents: number;
  nth: number;
  snapshot: { total_price_cents: number; number_of_installments: number } | null;
  plan: { number_of_installments: number } | null;
}): number | undefined {
  const { snapshot, plan } = input;
  if (snapshot === null && plan === null) throw nilReceiver("calculate_installment_payment_price_cents");
  const [total, count] = snapshot !== null ? [snapshot.total_price_cents, snapshot.number_of_installments] : [input.totalPriceCents, plan!.number_of_installments];
  if (count < 1) throw new NotPortedError("a plan with no instalments", "product_installment_plan.rb:60");
  return installmentPaymentAt(installmentPayments(total, count), input.nth);
}

// What Purchase#original_offer_code answers with: the code itself, or, for a purchase with a cached
// discount, an unsaved code carrying the discount's amount and usage mode.
export type PricingCode = Amounts & { flags: bigint | number };

export const isOncePerCart = (code: Pick<PricingCode, "flags">) => OfferCodeFlags.isSet(code.flags, "once_per_cart");

// Purchase#currency_minimum_or_zero
export function currencyMinimumOrZero(priceCents: number, minPrice: number): number {
  const rounded = rubyRound(priceCents);
  if (rounded > 0 && rounded < minPrice) return minPrice;
  return rounded;
}

export type PricingInput = {
  quantity: number;
  // minimum_paid_price_cents_per_unit_before_discount
  unitPriceCents: number;
  // offer_code_for_pricing
  code: PricingCode | null;
  // offer_code_applies_to_selected_variant?
  codeApplies: boolean;
  // link.currency["min_price"], read where Ruby reads it
  minPrice: () => number;
  isCommissionCompletion: boolean;
  // link.native_type == "commission"
  isCommissionProduct: boolean;
  isInstallmentPayment: boolean;
  // is_purchasing_power_parity_discounted
  isPpp: boolean;
  // link.purchasing_power_parity_enabled? (asked of a PPP-discounted purchase only)
  pppEnabled: boolean;
};

// Purchase#minimum_paid_price_cents up to the split into installments: the total the instalments
// divide (`minimum_price_cents`).
export function minimumPriceBeforeSplit(input: PricingInput): number {
  const { quantity, unitPriceCents: unit, code } = input;
  const oncePerCartFixed = code !== null && isCents(code) && isOncePerCart(code);
  const amountOffOf = (price: number) => (!input.codeApplies || code === null ? 0 : amountOff(code, price));

  let minimumPriceCents = oncePerCartFixed ? unit * quantity - amountOffOf(unit * quantity) : (unit - amountOffOf(unit)) * quantity;
  // Offer codes may exceed the price; the floor comes before the split into instalments.
  if (code !== null && minimumPriceCents < 0) minimumPriceCents = 0;
  if (oncePerCartFixed) minimumPriceCents = currencyMinimumOrZero(minimumPriceCents, input.minPrice());
  if (input.isPpp && input.pppEnabled && code === null) throw new NotPortedError("PurchasingPowerParityService#get_factor", "purchase.rb:1974");
  if (input.isInstallmentPayment) minimumPriceCents = rubyRound(minimumPriceCents);
  return minimumPriceCents;
}

// Whether the split into instalments is read at all (`calculate_installment_payment_price_cents`).
export const splitsIntoInstallments = (input: Pick<PricingInput, "isCommissionCompletion" | "isCommissionProduct" | "isInstallmentPayment">) =>
  !input.isCommissionCompletion && !input.isCommissionProduct && input.isInstallmentPayment;

// The rest of Purchase#minimum_paid_price_cents. `installmentPayment` is the buyer's instalment, when
// the price is split.
export function minimumPaidPrice(input: PricingInput, minimumPriceCents: number, installmentPayment: number | undefined): number {
  let minimumPrice: number | undefined = minimumPriceCents;
  if (input.isCommissionCompletion) minimumPrice *= 1 - COMMISSION_DEPOSIT_PROPORTION;
  else if (input.isCommissionProduct) minimumPrice *= COMMISSION_DEPOSIT_PROPORTION;
  else if (input.isInstallmentPayment) minimumPrice = installmentPayment;

  // If a PPP discount decreases the price to a value lower than the minimum, round the price up to the minimum.
  if (input.isPpp && minimumPriceCents !== 0 && minimumPriceCents < input.minPrice()) minimumPrice = input.minPrice();
  if (minimumPrice === undefined) throw nilReceiver("round");
  return rubyRound(minimumPrice);
}

// A PurchaseOfferCodeDiscount with its `belongs_to :offer_code`.
export class DiscountRecord {
  row: PurchaseOfferCodeDiscount;
  offerCodeLoad: Promise<OfferCodeRecord | null> | undefined;

  constructor(row: PurchaseOfferCodeDiscount) {
    this.row = row;
  }

  offerCode(): Promise<OfferCodeRecord | null> {
    this.offerCodeLoad ??= findById<OfferCode>("OfferCode", this.row.offer_code_id).then((row) => (row === null ? null : new OfferCodeRecord(row)));
    return this.offerCodeLoad;
  }
}

export class PurchaseRecord {
  row: Purchase;
  // The subscription this purchase was loaded through: `has_one :original_purchase` sets the
  // inverse, so `purchase.subscription` is that very record, not a second load.
  owner: SubscriptionRecord | null;
  memo: Map<string, Promise<unknown>>;

  constructor(row: Purchase, owner: SubscriptionRecord | null) {
    this.row = row;
    this.owner = owner;
    this.memo = new Map();
  }

  loaded<T>(key: string, load: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = load();
      this.memo.set(key, value);
    }
    return value;
  }

  get id(): bigint {
    return this.row.id;
  }

  flag(name: Parameters<typeof PurchaseFlags.isSet>[1]): boolean {
    return PurchaseFlags.isSet(this.row.flags, name);
  }

  get quantity(): number {
    return this.row.quantity ?? 1;
  }

  // ----- associations

  // `has_one :purchase_offer_code_discount`
  purchaseOfferCodeDiscount(): Promise<DiscountRecord | null> {
    return this.loaded("purchase_offer_code_discount", async () => {
      const row = await findOneBy<PurchaseOfferCodeDiscount>("PurchaseOfferCodeDiscount", "purchase_id", this.id);
      return row === null ? null : new DiscountRecord(row);
    });
  }

  // `belongs_to :offer_code`
  offerCode(): Promise<OfferCodeRecord | null> {
    return this.loaded("offer_code", async () => {
      const row = await findById<OfferCode>("OfferCode", this.row.offer_code_id);
      return row === null ? null : new OfferCodeRecord(row);
    });
  }

  link(): Promise<Link | null> {
    return this.loaded("link", () => findById<Link>("Link", this.row.link_id));
  }

  price(): Promise<BasePrice | null> {
    return this.loaded("price", () => findById<BasePrice>("BasePrice", this.row.price_id));
  }

  // `belongs_to :subscription`
  subscription(): Promise<SubscriptionRecord | null> {
    return Promise.resolve(this.owner);
  }

  // `purchase.subscription` as a row, for readers that only look at its columns: the inverse of
  // `original_purchase` when the purchase was loaded through one, else the `belongs_to` load.
  subscriptionRow(): Promise<Subscription | null> {
    if (this.owner !== null) return Promise.resolve(this.owner.row);
    return this.loaded("subscription_row", () => findById<Subscription>("Subscription", this.row.subscription_id));
  }

  // `belongs_to :seller`
  seller(): Promise<User | null> {
    return this.loaded("seller", () => findById<User>("User", this.row.seller_id));
  }

  // `has_one :license`
  license(): Promise<License | null> {
    return this.loaded("license", () => findOneBy<License>("License", "purchase_id", this.id));
  }

  // `has_one :tip`
  tip(): Promise<Tip | null> {
    return this.loaded("tip", () => findOneBy<Tip>("Tip", "purchase_id", this.id));
  }

  private variantAttributesJoin(): Prisma.Sql {
    return Prisma.sql`FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${this.id}`;
  }

  // `has_and_belongs_to_many :variant_attributes`
  variantAttributes(): Promise<VariantRecord[]> {
    return this.loaded("variant_attributes", async () =>
      (await selectRows(Prisma.sql`SELECT ${star("base_variants")} ${this.variantAttributesJoin()}`)).map((row) => new VariantRecord(castRow<BaseVariant>("BaseVariant", row))),
    );
  }

  // `variant_attributes.empty?`: one existence query unless the association is loaded.
  async hasNoVariantAttributes(): Promise<boolean> {
    if (this.memo.has("variant_attributes")) return (await this.variantAttributes()).length === 0;
    return (await selectRows(Prisma.sql`SELECT 1 AS one ${this.variantAttributesJoin()} LIMIT 1`)).length === 0;
  }

  // ----- prices

  // Purchase#price_for_recurrence (`price || subscription&.price`)
  async priceForRecurrence(): Promise<BasePrice | null> {
    const own = await this.price();
    if (own !== null) return own;
    const subscription = await this.subscription();
    return subscription === null ? null : subscription.price();
  }

  // Purchase#base_product_price_cents
  async baseProductPriceCents(): Promise<number> {
    if ((await this.priceForRecurrence()) !== null) return (await this.priceForRecurrence())!.price_cents;
    const rental = this.flag("is_rental");
    const link = await this.link();
    if (link === null) throw nilReceiver(rental ? "rental_price_cents" : "price_cents");
    return (rental ? link.rental_price_cents : link.price_cents) ?? nullOperand("+");
  }

  // Purchase#variant_extra_cost
  async variantExtraCost(): Promise<number> {
    if (await this.hasNoVariantAttributes()) return 0;

    const link = await this.link();
    if (link === null) throw nilReceiver("is_tiered_membership");
    if (LinkFlags.isSet(link.flags, "is_tiered_membership")) {
      let sum = 0;
      for (const variant of await this.variantAttributes()) {
        if (variant.row.type === "Sku") throw nilReceiver("prices", "an instance of Sku");
        // Purchase#subscription_duration: `price_for_recurrence&.recurrence`
        const recurrence = (await this.priceForRecurrence())?.recurrence ?? null;
        const recurrenceIs = recurrence === null ? Prisma.sql`${column("prices", "recurrence")} IS NULL` : Prisma.sql`${column("prices", "recurrence")} = ${recurrence}`;
        const [price] = await selectRows(
          Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${variant.row.id} AND ${column("prices", "deleted_at")} IS NULL AND ${Prisma.sql`(${PriceFlags.condition("is_rental", false)})`} AND ${recurrenceIs} LIMIT 1`,
        );
        sum += price ? castRow<BasePrice>("BasePrice", price).price_cents ?? 0 : 0;
      }
      return sum;
    }
    return (await this.variantAttributes()).reduce((total, variant) => total + (variant.row.price_difference_cents ?? 0), 0);
  }

  // Purchase#minimum_paid_price_cents_per_unit_before_discount
  async minimumPaidPriceCentsPerUnitBeforeDiscount(): Promise<number> {
    return (await this.baseProductPriceCents()) + (await this.variantExtraCost());
  }

  // ----- offer code

  // Purchase#has_cached_offer_code?
  async hasCachedOfferCode(): Promise<boolean> {
    return (await this.purchaseOfferCodeDiscount()) !== null;
  }

  // Purchase#original_offer_code
  async originalOfferCode(includeDeleted: boolean): Promise<PricingCode | null> {
    const offerCode = await this.offerCode();
    if (offerCode !== null && offerCode.deleted && !includeDeleted) {
      const original = (await (await this.purchaseOfferCodeDiscount())?.offerCode()) ?? null;
      if (!(original !== null && original.tiered())) return null;
    }

    const discount = await this.purchaseOfferCodeDiscount();
    if (discount === null) return offerCode === null ? null : offerCode.row;

    const original = await discount.offerCode();
    if (original === null) throw nilReceiver("flags");
    const bit = OfferCodeFlags.bit("once_per_cart");
    const flags = discount.row.once_per_cart ? BigInt(original.row.flags) | bit : BigInt(original.row.flags) & ~bit;
    return discount.row.offer_code_is_percent
      ? { amount_percentage: discount.row.offer_code_amount, amount_cents: null, flags }
      : { amount_cents: discount.row.offer_code_amount, amount_percentage: null, flags };
  }

  // Purchase#offer_code_for_pricing: the code whose discount applies to the price, which honours a
  // cached discount even after its code was deleted.
  async offerCodeForPricing(): Promise<PricingCode | null> {
    return this.originalOfferCode(this.flag("is_commission_completion_purchase") || (await this.hasCachedOfferCode()));
  }

  // Purchase#offer_code_applies_to_selected_variant?
  async offerCodeAppliesToSelectedVariant(): Promise<boolean> {
    let code = (await (await this.purchaseOfferCodeDiscount())?.offerCode()) ?? null;
    if (code === null) {
      // `|| offer_code_for_pricing`: with no cached discount that is the purchase's own code.
      if ((await this.offerCodeForPricing()) === null) return true;
      code = await this.offerCode();
      if (code === null) return true;
    }
    const link = await this.link();
    if (link === null) throw nilReceiver("id");
    return applicableToVariants(code, link, () => this.variantAttributes());
  }

  // Purchase#displayed_price_cents_before_offer_code
  async displayedPriceCentsBeforeOfferCode(includeDeleted: boolean): Promise<number | null> {
    const code = await this.originalOfferCode(includeDeleted);
    if (code === null) return this.row.displayed_price_cents;

    if (await this.hasCachedOfferCode()) {
      const discount = (await this.purchaseOfferCodeDiscount())!.row;
      if (discount.once_per_cart && !discount.offer_code_is_percent) {
        if (discount.pre_discount_displayed_price_cents != null) return discount.pre_discount_displayed_price_cents;
        const discountedProductPrice = (this.row.displayed_price_cents ?? nullOperand("-")) - ((await this.tip())?.value_cents ?? 0);
        if (discountedProductPrice === 0) return discount.pre_discount_minimum_price_cents * this.quantity;
        return discountedProductPrice + discount.offer_code_amount;
      }
      return discount.pre_discount_minimum_price_cents * this.quantity;
    }

    const price = originalPrice(code, this.row.displayed_price_cents);
    return price === null ? null : price * this.quantity;
  }

  // ----- minimum paid price

  // `link.purchasing_power_parity_enabled?`
  private async linkPurchasingPowerParityEnabled(link: Link): Promise<boolean> {
    if (LinkFlags.isSet(link.flags, "purchasing_power_parity_disabled")) return false;
    const owner = await this.loaded("link_user", () => findById<User>("User", link.user_id));
    if (owner === null) throw nilReceiver("purchasing_power_parity_enabled?");
    return UserFlags.isSet(owner.flags, "purchasing_power_parity_enabled");
  }

  // Purchase#calculate_installment_payment_price_cents (private): the instalment of the next charge,
  // from the plan snapshot the payment option holds or, without one, the product's plan.
  private async calculateInstallmentPaymentPriceCents(totalPriceCents: number): Promise<number | undefined> {
    const subscription = await this.subscription();
    // `subscription&.purchases&.successful&.count || 0`
    const nth = subscription === null ? 0 : await successfulPurchasesCount(subscription.id);
    const option = subscription === null ? null : await subscription.lastPaymentOption();
    const snapshot = option === null ? null : await subscription!.loaded(`snapshot:${String(option.id)}`, () => findOneBy<InstallmentPlanSnapshot>("InstallmentPlanSnapshot", "payment_option_id", option.id));
    // `installment_plan || subscription&.last_payment_option&.installment_plan`, read when there is no snapshot
    const plan = snapshot !== null || option === null ? null : await subscription!.loaded(`plan:${String(option.id)}`, () => findById<ProductInstallmentPlan>("ProductInstallmentPlan", option.product_installment_plan_id));
    return installmentPaymentFor({ totalPriceCents, nth, snapshot, plan });
  }

  // Purchase#minimum_paid_price_cents, for a purchase that is not a recurring charge, a pre-order
  // charge or a plan change (those read other rows).
  async minimumPaidPriceCents(): Promise<number> {
    if (this.flag("is_gift_receiver_purchase")) return 0;
    const perceived = perceivedPriceCents(this.row);
    if (perceived !== null && this.flag("is_commission_completion_purchase")) return Math.max(rubyToI(perceived) - ((await this.tip())?.value_cents ?? 0), 0);

    // is_recurring_subscription_charge: `subscription.present? && !original && !gift_receiver`
    if ((await this.subscription()) !== null && !this.flag("is_original_subscription_purchase")) throw new NotPortedError("Purchase#minimum_paid_price_cents of a recurring charge", "purchase.rb:1957");
    if (this.row.preorder_id != null && !this.flag("is_preorder_authorization")) throw new NotPortedError("Purchase#minimum_paid_price_cents of a pre-order charge", "purchase.rb:1959");

    const unitPriceCents = await this.minimumPaidPriceCentsPerUnitBeforeDiscount();
    const code = await this.offerCodeForPricing();
    const codeApplies = await this.offerCodeAppliesToSelectedVariant();

    // The product is read where Ruby reads it: for the code's options, the PPP check and `native_type`
    // (not for a commission completion, which is priced by its deposit).
    const isPpp = this.flag("is_purchasing_power_parity_discounted");
    const isCommissionCompletion = this.flag("is_commission_completion_purchase");
    const link = code !== null || isPpp || !isCommissionCompletion ? await this.link() : null;
    const input: PricingInput = {
      quantity: this.quantity,
      unitPriceCents,
      code,
      codeApplies,
      minPrice: () => currencyMinPrice(link ?? nullOperand("currency")),
      isCommissionCompletion,
      isCommissionProduct: !isCommissionCompletion && (link ?? nullOperand("native_type")).native_type === NATIVE_TYPE_COMMISSION,
      isInstallmentPayment: this.flag("is_installment_payment"),
      isPpp,
      pppEnabled: isPpp && (await this.linkPurchasingPowerParityEnabled(link ?? nullOperand("purchasing_power_parity_enabled?"))),
    };
    const total = minimumPriceBeforeSplit(input);
    const installmentPayment = splitsIntoInstallments(input) ? await this.calculateInstallmentPaymentPriceCents(total) : undefined;
    return minimumPaidPrice(input, total, installmentPayment);
  }
}

// Purchase#perceived_price_cents (`attr_json_data_accessor`): the value in json_data, when present.
function perceivedPriceCents(row: Pick<Purchase, "json_data">): number | string | null {
  if (row.json_data == null || row.json_data === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(row.json_data);
  } catch {
    throw new NotPortedError("json_data that is not JSON", "json_data.rb:38");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new NotPortedError("json_data that is not a Hash", "json_data.rb:38");
  const value = (data as Record<string, unknown>).perceived_price_cents;
  if (value === undefined || value === null || value === "" || value === false) return null;
  if (typeof value !== "number" && typeof value !== "string") throw new NotPortedError("a perceived_price_cents that is not a number", "purchase.rb:94");
  return value;
}
