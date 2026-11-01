// Subscription#current_subscription_price_cents (app/models/subscription.rb): what the next renewal
// of a subscription charges. An installment plan charges the original purchase's instalment; a
// membership charges the original purchase's price, less the discount it keeps (a code that is still
// running, or a renewal-eligible code that applies to the buyer now: `compute_auto_renewal_offer_code`).
//
// Reads only, in Ruby's order: each association loads once per record (`SubscriptionRecord.loaded`,
// `PurchaseRecord.loaded`) and the rest goes to MySQL every time, answered by the query cache.
// Golden: worker/jobs/__fixtures__/subscription-reminder-jobs.golden.json (the `price:` and
// `missing charge:` cases); the arithmetic: offer-code-pricing-vectors.golden.json.
import { Prisma, type Link, type OfferCode, type User } from "@prisma/client";

import { rubyRound, rubyToI } from "./concerns/ruby-numeric.ts";
import { amountOff, isCents, nilReceiver, OfferCodeRecord, type Amounts } from "./offer-code.ts";
import { currencyMinPrice, PurchaseRecord, quantityOf, successfulPurchasesCount } from "./purchase-pricing.ts";
import { findById } from "./row-reads.ts";
import { castRow, column, columnIn, quoteName, selectRows, table } from "./sql.ts";
import type { SubscriptionRecord } from "./subscription.ts";

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);
const RENEWAL_ELIGIBLE = Prisma.raw("(existing_customers_only = '1' OR JSON_LENGTH(ownership_duration_tiers) > 0)");
const nullOperand = (method: string): never => {
  throw nilReceiver(method);
};

// `Integer > nil`
const incomparable = (): never => {
  throw new TypeError("comparison of Integer with nil failed");
};

// Subscription::AutoRenewalDiscount
type AutoRenewalDiscount = { offerCode: OfferCodeRecord; amount: number; isPercent: boolean };

// `original_purchase`, with the associations the price reads.
function originalPurchaseOf(sub: SubscriptionRecord): Promise<PurchaseRecord | null> {
  return sub.loaded("pricing:original_purchase", async () => {
    const row = await sub.originalPurchase();
    return row === null ? null : new PurchaseRecord(row, sub);
  });
}

// Subscription#discount_applies_to_next_charge?
async function discountAppliesToNextCharge(sub: SubscriptionRecord, original: PurchaseRecord | null): Promise<boolean> {
  if (sub.flag("is_installment_plan")) return true;
  if (original === null) throw nilReceiver("purchase_offer_code_discount");
  const duration = (await original.purchaseOfferCodeDiscount())?.row.duration_in_months ?? null;
  return duration === null || (await successfulPurchasesCount(sub.id)) < duration;
}

// Subscription#original_renewal_offer_code
async function originalRenewalOfferCode(original: PurchaseRecord): Promise<OfferCodeRecord | null> {
  return (await (await original.purchaseOfferCodeDiscount())?.offerCode()) ?? (await original.offerCode());
}

// Subscription#reuse_original_discount_on_next_charge?
async function reuseOriginalDiscountOnNextCharge(sub: SubscriptionRecord, original: PurchaseRecord | null): Promise<boolean> {
  if (!(await discountAppliesToNextCharge(sub, original)) || original === null) return false;
  if ((await originalRenewalOfferCode(original))?.tiered()) return false;
  const code = await original.offerCode();
  const discount = await original.purchaseOfferCodeDiscount();
  if (code?.deleted && discount !== null && rubyToI(discount.row.offer_code_amount) === 0) return false;
  return discount !== null || (await original.offerCode()) !== null;
}

// Subscription#cached_tiered_pwyw_renewal_pre_discount_total_cents: a pay-what-you-want buyer of a
// tiered code paid above the discounted minimum; undo the percentage their tier took off.
export function cachedTieredPwywPreDiscountTotal(input: { percent: number; preDiscountMinimumPriceCents: number; quantity: number; displayedPriceCents: number }): number | null {
  const { percent, quantity, displayedPriceCents: displayed } = input;
  const discountedBaseTotal = rubyRound(input.preDiscountMinimumPriceCents * quantity * (1 - percent / 100.0));
  if (!(displayed > discountedBaseTotal)) return null;
  if (percent === 0 || percent >= 100) return displayed;
  return rubyRound(displayed / (1 - percent / 100.0));
}

async function cachedTieredPwywRenewalPreDiscountTotalCents(original: PurchaseRecord): Promise<number | null> {
  const discount = await original.purchaseOfferCodeDiscount();
  const code = discount === null ? null : await discount.offerCode();
  if (discount === null || !(code?.tiered() && discount.row.offer_code_is_percent)) return null;
  return cachedTieredPwywPreDiscountTotal({
    percent: rubyToI(discount.row.offer_code_amount),
    preDiscountMinimumPriceCents: discount.row.pre_discount_minimum_price_cents,
    quantity: quantityOf(original.row),
    displayedPriceCents: original.row.displayed_price_cents ?? nullOperand(">"),
  });
}

// Subscription#renewal_pre_discount_total_cents
async function renewalPreDiscountTotalCents(original: PurchaseRecord): Promise<number | null> {
  const cached = await cachedTieredPwywRenewalPreDiscountTotalCents(original);
  if (cached !== null) return cached;
  return (await original.displayedPriceCentsBeforeOfferCode(true)) ?? original.row.displayed_price_cents;
}

// Subscription#auto_renewal_discount_amount_off_cents and #auto_renewal_discounted_total_cents,
// once the unit price (only a fixed code that is not once-per-cart reads it) is known.
export function autoRenewalDiscountedTotal(input: {
  preDiscountTotalCents: number | null;
  isPercent: boolean;
  amount: number;
  // The code's own amount_cents is present, and it is once-per-cart
  codeIsCents: boolean;
  oncePerCart: boolean;
  unitPriceCents: number | null;
  quantity: number;
  minPrice: () => number;
}): number {
  const { preDiscountTotalCents: pre, amount } = input;
  const amounts: Amounts = input.isPercent ? { amount_percentage: amount, amount_cents: null } : { amount_cents: amount, amount_percentage: null };
  const amountOffCents = input.isPercent ? amountOff(amounts, pre) : input.oncePerCart ? amount : amountOff(amounts, input.unitPriceCents) * input.quantity;
  let discountedTotal = Math.max((pre ?? nullOperand("-")) - amountOffCents, 0);
  if (input.codeIsCents && input.oncePerCart && discountedTotal > 0) discountedTotal = Math.max(discountedTotal, input.minPrice());
  return discountedTotal;
}

async function autoRenewalDiscountedTotalCents(original: PurchaseRecord, link: Link, auto: AutoRenewalDiscount, preDiscountTotalCents: number | null): Promise<number> {
  // `renewal_pre_discount_price_cents`: read for a fixed code, though the code's amount is what comes off.
  const unitPriceCents = !auto.isPercent && !auto.offerCode.oncePerCart ? await original.minimumPaidPriceCentsPerUnitBeforeDiscount() : null;
  return autoRenewalDiscountedTotal({
    preDiscountTotalCents,
    isPercent: auto.isPercent,
    amount: auto.amount,
    codeIsCents: isCents(auto.offerCode.row),
    oncePerCart: auto.offerCode.oncePerCart,
    unitPriceCents,
    quantity: quantityOf(original.row),
    minPrice: () => currencyMinPrice(link),
  });
}

// `.includes(:ownership_products)`: the join rows of every code in one statement, then their products.
async function preloadOwnershipProducts(codes: OfferCodeRecord[]): Promise<void> {
  if (codes.length === 0) return;
  const joins = await selectRows<{ offer_code_id: bigint | number; product_id: bigint | number }>(
    Prisma.sql`SELECT ${star("offer_codes_ownership_products")} FROM ${table("offer_codes_ownership_products")} WHERE ${columnIn("offer_codes_ownership_products", "offer_code_id", codes.map((code) => code.id))}`,
  );
  const productIds = [...new Map(joins.map((join) => [String(join.product_id), join.product_id])).values()];
  const links = productIds.length === 0 ? [] : (await selectRows(Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${columnIn("links", "id", productIds)}`)).map((row) => castRow<Link>("Link", row));
  const byId = new Map(links.map((link) => [String(link.id), link]));
  for (const code of codes) {
    const owned = joins.filter((join) => String(join.offer_code_id) === String(code.id)).map((join) => byId.get(String(join.product_id)));
    code.preload("ownership_products", owned.filter((link): link is Link => link !== undefined));
  }
}

const toCodes = (rows: Record<string, unknown>[]) => rows.map((row) => new OfferCodeRecord(castRow<OfferCode>("OfferCode", row)));

// Subscription#compute_auto_renewal_offer_code
async function computeAutoRenewalOfferCode(sub: SubscriptionRecord, original: PurchaseRecord | null): Promise<AutoRenewalDiscount | null> {
  const buyer = await sub.user();
  const link = await sub.link();
  if (link === null || original === null) return null;
  if (await reuseOriginalDiscountOnNextCharge(sub, original)) return null;

  // `link.universal_offer_codes` asks the product's seller for the codes before either relation loads.
  const owner = await sub.loaded("link_user", () => findById<User>("User", link.user_id));
  if (owner === null) throw nilReceiver("offer_codes");
  const originalRenewal = await originalRenewalOfferCode(original);
  const originalTiered = originalRenewal?.tiered() ? originalRenewal : null;

  const productCodes = toCodes(
    await selectRows(
      Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} INNER JOIN ${table("offer_codes_products")} ON ${column("offer_codes", "id")} = ${column("offer_codes_products", "offer_code_id")} WHERE ${column("offer_codes_products", "product_id")} = ${link.id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${RENEWAL_ELIGIBLE}`,
    ),
  );
  await preloadOwnershipProducts(productCodes);
  const universalCodes = toCodes(
    await selectRows(
      Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${owner.id} AND (universal = 1 and (currency_type = ${link.price_currency_type} or currency_type is null)) AND ${column("offer_codes", "deleted_at")} IS NULL AND (NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${String(link.id)})) AND ${RENEWAL_ELIGIBLE}`,
    ),
  );
  await preloadOwnershipProducts(universalCodes);

  // `.uniq`: the first of each id.
  const candidates = [...productCodes, ...universalCodes, ...(originalTiered === null ? [] : [originalTiered])].filter((code, i, all) => all.findIndex((other) => other.id === code.id) === i);
  if (candidates.length === 0) return null;

  const now = sub.now();
  const quantity = quantityOf(original.row);
  let best: { discount: AutoRenewalDiscount; saved: number } | null = null;
  for (const code of candidates) {
    // eligible_auto_renewal_offer_code?
    const isOriginal = code.sameAs(originalRenewal);
    if (code.inactive(now) && !isOriginal) continue;
    if (code.row.duration_in_months != null) continue;
    if (!(isOriginal || (await code.isValidForPurchase(quantity, now)))) continue;
    if (!isOriginal && code.row.minimum_quantity != null && code.row.minimum_quantity > quantity) continue;
    if (!isOriginal && code.row.minimum_amount_cents != null && code.row.minimum_amount_cents > ((await renewalPreDiscountTotalCents(original)) ?? incomparable())) continue;

    const resolved = await code.evaluateForBuyer(buyer, link, original.row.created_at, now);
    // auto_renewal_discount_for
    if (resolved === null) continue;
    let discount: AutoRenewalDiscount;
    if (resolved.type === "percent") {
      const amount = rubyToI(resolved.percents);
      if (!(amount > 0 || (code.tiered() && amount === 0))) continue;
      discount = { offerCode: code, amount, isPercent: true };
    } else {
      const amount = rubyToI(resolved.cents);
      if (!(amount > 0)) continue;
      discount = { offerCode: code, amount, isPercent: false };
    }

    const discountedTotal = await autoRenewalDiscountedTotalCents(original, link, discount, await renewalPreDiscountTotalCents(original));
    const saved = ((await renewalPreDiscountTotalCents(original)) ?? nullOperand("-")) - discountedTotal;
    // max_by: the first of equal savings stays.
    if (best === null || saved > best.saved) best = { discount, saved };
  }
  return best?.discount ?? null;
}

export async function currentSubscriptionPriceCents(sub: SubscriptionRecord): Promise<number | null> {
  const original = await originalPurchaseOf(sub);
  if (sub.flag("is_installment_plan")) {
    if (original === null) throw nilReceiver("minimum_paid_price_cents");
    return original.minimumPaidPriceCents();
  }
  if (await reuseOriginalDiscountOnNextCharge(sub, original)) return original!.row.displayed_price_cents;

  const preDiscount = await renewalPreDiscountTotalCents(original!);
  const auto = await sub.loaded("pricing:auto_renewal_offer_code", () => computeAutoRenewalOfferCode(sub, original));
  if (auto === null) return preDiscount;
  return autoRenewalDiscountedTotalCents(original!, (await sub.link())!, auto, preDiscount);
}

