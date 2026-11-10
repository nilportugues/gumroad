// Port of app/controllers/offer_codes_controller.rb#compute_discount and the read-only core of
// app/services/offer_code_discount_computing_service.rb (cart of permalinks, `key_by_input: false`).
//
// A signed-out visitor has no purchases, so an existing-customers code gives them nothing and a tiered one its month-0
// tier; a signed-in buyer is measured against their purchase history (`ownershipMonthsFor`, `returningCustomer`).
// A malformed query is the one shape left to Rails (HandBackToRails).
import { Prisma, type Link, type User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import type { OfferCodeRecord } from "../models/offer-code.ts";
import { rubyInteger } from "../models/product-affiliate.ts";
import { currencyMinPrice } from "../models/purchase-pricing.ts";
import { selectRows, castRow, column, table } from "../models/sql.ts";
import { paramToI } from "../page-props/audience/support.ts";
import {
  applicable,
  asRecord,
  currencyValid,
  fullDiscount,
  normalizeCode,
  star,
} from "../presenters/best-offer-code.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import { HandBackToRails, type Rendered } from "./application-controller.ts";
import { parseQuery, type Query } from "./rails-query.ts";
import type { RailsRequest } from "./rails-request.ts";

export const INELIGIBILITY_MESSAGES: Record<string, string> = {
  insufficient_times_of_use: "Sorry, the discount code you are using is invalid for the quantity you have selected.",
  sold_out: "Sorry, the discount code you wish to use has reached its usage limit.",
  invalid_offer: "Sorry, the discount code you wish to use is invalid.",
  inactive: "Sorry, the discount code you wish to use is inactive.",
  unmet_minimum_purchase_quantity: "Sorry, the discount code you wish to use has an unmet minimum quantity.",
  not_existing_customer: "Sorry, this discount code is only for existing customers.",
  not_new_customer: "Sorry, this discount code is only for new customers.",
  option_not_eligible: "This code does not apply to the selected option.",
};

export const PARTIAL_APPLICATION_MESSAGES: Record<string, string> = {
  insufficient_times_of_use:
    "The discount code was applied to some products. The rest exceed the quantity still available on the code.",
  sold_out: "The discount code was applied to some products. The rest exceed its remaining usage limit.",
  unmet_minimum_purchase_quantity:
    "The discount code was applied to some products. The rest do not meet its minimum quantity.",
  not_existing_customer:
    "The discount code was applied to some products. The rest are only discounted for existing customers.",
  not_new_customer: "The discount code was applied to some products. The rest are only discounted for new customers.",
  option_not_eligible: "The code applies to some items. The selected options for the other items are not eligible.",
};

// OfferCodeDiscountComputingService::PRODUCT_LEVEL_INELIGIBILITIES_BY_DISPLAY_PRIORITY
const DISPLAY_PRIORITY = [
  "not_existing_customer",
  "not_new_customer",
  "unmet_minimum_purchase_quantity",
  "insufficient_times_of_use",
  "sold_out",
  "option_not_eligible",
] as const;

export type CartLine = {
  permalink?: string;
  quantity?: string;
  variant_external_id?: string;
  price_cents?: string;
  tip_cents?: string;
};

// aggregate_products: the lines of one permalink collapse into one whose quantity is the sum; the submitted prices
// (and tips) add up only when every line carries an integer price.
type Aggregate = { quantity: number; price_cents?: number; tip_cents: number };

function aggregateLines(lines: CartLine[]): Aggregate {
  const quantity = lines.reduce((sum, line) => sum + paramToI(line.quantity ?? ""), 0);
  const prices = lines.map((line) => (line.price_cents === undefined ? null : rubyInteger(line.price_cents)));
  if (prices.some((price) => price === null)) return { quantity, tip_cents: 0 };
  const tips = lines.reduce(
    (sum, line) => sum + (line.tip_cents === undefined ? 0 : (rubyInteger(line.tip_cents) ?? 0)),
    0,
  );
  return { quantity, price_cents: prices.reduce<number>((sum, price) => sum + price!, 0), tip_cents: tips };
}
export type ComputeResult = {
  products_data: Record<string, Record<string, unknown>>;
  error_code: string | null;
  partial_ineligibility_code: string | null;
};

// OfferCodesController#product_params: only scalar line-item fields are read; a nested or repeated shape reads as absent.
export function cartLines(query: Query): Record<string, CartLine> {
  const products = query.products;
  if (typeof products !== "object" || products === null || Array.isArray(products)) return {};
  const lines: Record<string, CartLine> = {};
  for (const [key, line] of Object.entries(products)) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) continue;
    const scalars: Record<string, string> = {};
    for (const [field, value] of Object.entries(line)) if (typeof value === "string") scalars[field] = value;
    lines[key] = scalars;
  }
  return lines;
}

// Link.visible.where(unique_permalink: ...): Rails indexes the rows by permalink, in the order the cart lists them.
async function visibleLinks(permalinks: string[]): Promise<Link[]> {
  if (permalinks.length === 0) return [];
  const rows = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} IN (${Prisma.join(permalinks)})`,
  );
  const byPermalink = new Map(
    rows.map((row) => castRow<Link>("Link", row)).map((link) => [link.unique_permalink, link]),
  );
  return permalinks.flatMap((permalink) => byPermalink.get(permalink) ?? []);
}

// Link#available_cross_sells: the seller's alive, unpaused cross-sells that list this product or are universal, and
// the products they offer (any state, as `cross_sell.product` is a plain belongs_to), in upsell order.
async function availableCrossSellProducts(link: Link): Promise<Link[]> {
  const rows = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${column("upsells", "id")} AS upsell_id, ${column("upsells", "product_id")} AS product_id FROM ${table("upsells")} LEFT OUTER JOIN ${table("upsells_selected_products")} ON ${column("upsells_selected_products", "upsell_id")} = ${column("upsells", "id")} WHERE ${column("upsells", "seller_id")} = ${link.user_id} AND ${column("upsells", "cross_sell")} = TRUE AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = FALSE AND (${column("upsells_selected_products", "selected_product_id")} = ${link.id} OR ${column("upsells", "universal")} = TRUE) ORDER BY ${column("upsells", "id")} ASC`,
  );
  const productIds = [
    ...new Map(rows.map((row) => [String(row.upsell_id), row.product_id as number | bigint])).values(),
  ];
  if (productIds.length === 0) return [];
  const products = (
    await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(productIds)})`,
    )
  ).map((row) => castRow<Link>("Link", row));
  const byId = new Map(products.map((product) => [String(product.id), product]));
  return productIds.flatMap((id) => byId.get(String(id)) ?? []);
}

// OfferCode#evaluate_for_buyer merged over the full discount hash, as `discount.merge(...)` does.
async function resolveForBuyer(
  code: OfferCodeRecord,
  buyer: User | null,
  link: Link,
  full: Record<string, unknown>,
  now: Date,
): Promise<Record<string, unknown> | null> {
  const resolved = await code.evaluateForBuyer(buyer, link, null, now);
  if (resolved === null) return null;
  return code.tiered() ? { ...full, ...resolved } : full;
}

// OfferCodeDiscountComputingService#returning_customer?: only the signed-in buyer is recognised, by account and email.
function returningCustomer(code: OfferCodeRecord, buyer: User): Promise<boolean> {
  return code.returningCustomer([buyer.id], [buyer.email]);
}

// OfferCodeDiscountComputingService#allocate_once_per_cart_discount: the code's fixed amount is shared across the cart's
// lines in order, each taking what its price can absorb without leaving a remainder under the currency's minimum.
function allocateOncePerCart(
  discount: Record<string, unknown>,
  code: OfferCodeRecord,
  line: Aggregate,
  link: Link,
  allocations: Map<number, number>,
): Record<string, unknown> {
  const left = allocations.get(code.id) ?? (discount.once_per_cart_amount_cents as number);
  // once_per_cart_allocation_capacity
  const fullPrice =
    line.price_cents === undefined ? link.price_cents! * line.quantity : Math.max(line.price_cents - line.tip_cents, 0);
  let allocated = Math.min(left, fullPrice);
  const priceAfterDiscount = fullPrice - allocated;
  if (priceAfterDiscount > 0) {
    const minPrice = currencyMinPrice(link);
    if (priceAfterDiscount < minPrice) allocated = Math.max(fullPrice - minPrice, 0);
  }
  allocations.set(code.id, left - allocated);
  return { ...discount, cents: allocated };
}

// OfferCodeDiscountComputingService#process
export async function processDiscount(
  code: string,
  lines: Record<string, CartLine>,
  buyer: User | null,
  now: Date,
): Promise<ComputeResult> {
  const entriesByPermalink = new Map<string, CartLine[]>();
  for (const line of Object.values(lines))
    entriesByPermalink.set(line.permalink!, [...(entriesByPermalink.get(line.permalink!) ?? []), line]);
  const permalinks = [
    ...new Set(
      Object.values(lines)
        .map((line) => line.permalink)
        .filter((permalink): permalink is string => permalink !== undefined),
    ),
  ];
  const links = await visibleLinks(permalinks);

  // `OfferCode.none if code.blank?`
  const codes: OfferCodeRecord[] =
    code.trim() === "" || links.length === 0
      ? []
      : (
          await selectRows<Record<string, unknown>>(
            Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} IN (${Prisma.join([...new Set(links.map((link) => link.user_id))])}) AND ${column("offer_codes", "code")} = ${code} AND ${column("offer_codes", "deleted_at")} IS NULL ORDER BY ${column("offer_codes", "id")} ASC`,
          )
        ).map(asRecord);

  const productsData: ComputeResult["products_data"] = {};
  const applicableCodes: OfferCodeRecord[] = [];
  const remaining = new Map<number, number>();
  const applied = new Set<number>();
  const allocations = new Map<number, number>();
  const ineligibilities = new Set<string>();

  // find_applicable_offer_code_for
  const applicableCodeFor = async (link: Link): Promise<OfferCodeRecord | null> => {
    for (const candidate of codes.filter((candidate) => String(candidate.row.user_id) === String(link.user_id))) {
      if ((await applicable(candidate, link)) && currencyValid(candidate, link)) return candidate;
    }
    return null;
  };
  const isOncePerCart = (candidate: OfferCodeRecord) => candidate.row.amount_cents != null && candidate.oncePerCart;
  // `evaluate_for_buyer(buyer, product: link) unless returning_customer?(offer_code)`. With no buyer that is nil for an
  // existing-customers code or a tiered one that has no tier starting at month 0.
  const discountFor = async (candidate: OfferCodeRecord, link: Link): Promise<Record<string, unknown> | null> => {
    const full = await fullDiscount(candidate);
    if (candidate.row.new_customers_only && buyer !== null && (await returningCustomer(candidate, buyer))) return null;
    if (candidate.row.existing_customers_only || candidate.tiered())
      return resolveForBuyer(candidate, buyer, link, full, now);
    return full;
  };

  // optimistically_apply_to_applicable_cross_sells: the cart may not meet a cross-sell's minimum or the code may run
  // out; checkout re-validates, so the buyer sees the discount early.
  const applyToCrossSells = async (link: Link) => {
    for (const product of await availableCrossSellProducts(link)) {
      if (productsData[product.unique_permalink!] !== undefined) continue;
      const crossSellCode = await applicableCodeFor(product);
      if (crossSellCode === null) continue;
      const resolved = await discountFor(crossSellCode, product);
      if (resolved === null) continue;
      // A spent once-per-cart code covers the cross-sell at zero, or the fixed amount would come off twice.
      productsData[product.unique_permalink!] =
        isOncePerCart(crossSellCode) && applied.has(crossSellCode.id) ? { ...resolved, cents: 0 } : resolved;
    }
  };

  for (const link of links) {
    const offerCode = await applicableCodeFor(link);
    if (offerCode === null) continue;
    applicableCodes.push(offerCode);

    // entries_eligible_for_option_scope: a line that omits the option stays (the product page previews that way);
    // a blank or unknown one is out of scope. The cart's quantity counts only the lines that stay.
    const entries = entriesByPermalink.get(link.unique_permalink!) ?? [];
    const restricted = await offerCode.restrictedVariantsFor(link);
    const restrictedIds = new Set(restricted.map((variant) => encrypt(variant.row.id)));
    const eligible =
      restricted.length === 0
        ? entries
        : entries.filter(
            (line) => line.variant_external_id === undefined || restrictedIds.has(line.variant_external_id),
          );
    if (eligible.length < entries.length) ineligibilities.add("option_not_eligible");
    if (eligible.length === 0) continue;

    const aggregate = aggregateLines(eligible);
    const quantity = aggregate.quantity;
    const { minimum_quantity: minimum, max_purchase_count: max } = offerCode.row;
    const meetsMinimum = minimum == null || quantity >= minimum;
    const left = async () => {
      if (!remaining.has(offerCode.id)) remaining.set(offerCode.id, await offerCode.quantityLeft(now));
      return remaining.get(offerCode.id)!;
    };

    const resolved = await discountFor(offerCode, link);

    const once = isOncePerCart(offerCode);
    // Later covered lines of a spent once-per-cart code stay in the response, without spending a use.
    if (once && applied.has(offerCode.id) && meetsMinimum) {
      if (resolved !== null) {
        productsData[link.unique_permalink!] = allocateOncePerCart(resolved, offerCode, aggregate, link, allocations);
        await applyToCrossSells(link);
      }
      continue;
    }

    // A fixed-amount code is applied once per cart, so a line spends one use however many units it holds.
    const units = once ? 1 : quantity;
    const sufficient = max == null || (await left()) >= units;
    if (resolved !== null && !offerCode.inactive(now) && meetsMinimum && sufficient) {
      if (max != null) remaining.set(offerCode.id, (await left()) - units);
      applied.add(offerCode.id);
      productsData[link.unique_permalink!] = once
        ? allocateOncePerCart(resolved, offerCode, aggregate, link, allocations)
        : resolved;
      await applyToCrossSells(link);
    } else {
      if (resolved === null && offerCode.row.existing_customers_only) ineligibilities.add("not_existing_customer");
      if (resolved === null && offerCode.row.new_customers_only) ineligibilities.add("not_new_customer");
      if (!meetsMinimum) ineligibilities.add("unmet_minimum_purchase_quantity");
      if (!sufficient) ineligibilities.add((await left()) > 0 ? "insufficient_times_of_use" : "sold_out");
    }
  }

  const priority = DISPLAY_PRIORITY.find((reason) => ineligibilities.has(reason)) ?? null;
  const hasData = Object.keys(productsData).length > 0;
  let errorCode: string | null = null;
  if (applicableCodes.length === 0) errorCode = "invalid_offer";
  else if (applicableCodes.every((candidate) => candidate.inactive(now))) errorCode = "inactive";
  else if (!hasData) errorCode = priority;
  return { products_data: productsData, error_code: errorCode, partial_ineligibility_code: hasData ? priority : null };
}

// OfferCodesController#compute_discount
export async function computeDiscount(request: RailsRequest, buyer: User | null, now = new Date()): Promise<Rendered> {
  let query: Query;
  try {
    query = parseQuery(request.queryString);
  } catch {
    throw new HandBackToRails("compute_discount with a malformed query");
  }
  // `normalize_code(params[:code])` calls `to_s`, so an array or hash code becomes its inspect text. That text starts
  // with `[` or `{`, which no stored code can contain, so it matches nothing and the cart answers invalid_offer.
  const code = typeof query.code === "string" || query.code === undefined ? normalizeCode(query.code ?? "") : "[]";
  const result = await processDiscount(code, cartLines(query), buyer, now);

  const response =
    result.error_code !== null
      ? { valid: false, error_code: result.error_code, error_message: INELIGIBILITY_MESSAGES[result.error_code] }
      : {
          valid: true,
          products_data: result.products_data,
          ...(result.partial_ineligibility_code === null
            ? {}
            : { notice: PARTIAL_APPLICATION_MESSAGES[result.partial_ineligibility_code] }),
        };
  return {
    status: 200,
    body: esJson(response as JsonValue),
    contentType: "application/json; charset=utf-8",
    paramsRead: true,
  };
}
