// Port of app/controllers/offer_codes_controller.rb#compute_discount and the read-only core of
// app/services/offer_code_discount_computing_service.rb (cart of permalinks, `key_by_input: false`).
//
// A code or cart that needs more than that hands back to Rails (HandBackToRails): a once-per-cart-fixed code and a
// line whose product has cross-sells to apply optimistically. A signed-out visitor has no purchases, so an
// existing-customers code gives them nothing and a tiered one its month-0 tier; a signed-in buyer is measured
// against their purchase history (`ownershipMonthsFor`, `returningCustomer`).
import { Prisma, type Link, type User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import type { OfferCodeRecord } from "../models/offer-code.ts";
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

export type CartLine = { permalink?: string; quantity?: string; variant_external_id?: string };
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

// Link#available_cross_sells reaches the seller's alive, unpaused cross-sells; applying a code to them is out of scope.
async function sellerHasAvailableCrossSells(userId: bigint | number): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("upsells")} WHERE ${column("upsells", "seller_id")} = ${userId} AND ${column("upsells", "cross_sell")} = TRUE AND ${column("upsells", "deleted_at")} IS NULL AND ${column("upsells", "paused")} = FALSE LIMIT 1`,
  );
  return rows.length > 0;
}

function assertSupported(code: OfferCodeRecord): void {
  if (code.row.amount_cents != null && code.oncePerCart)
    throw new HandBackToRails("compute_discount for a once-per-cart code");
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

// OfferCodeDiscountComputingService#process
export async function processDiscount(
  code: string,
  lines: Record<string, CartLine>,
  buyer: User | null,
  now: Date,
): Promise<ComputeResult> {
  const entriesByPermalink = new Map<string, CartLine[]>();
  for (const line of Object.values(lines))
    entriesByPermalink.set(line.permalink as string, [
      ...(entriesByPermalink.get(line.permalink as string) ?? []),
      line,
    ]);
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
  const ineligibilities = new Set<string>();

  for (const link of links) {
    let offerCode: OfferCodeRecord | null = null;
    for (const candidate of codes.filter((candidate) => String(candidate.row.user_id) === String(link.user_id))) {
      if ((await applicable(candidate, link)) && currencyValid(candidate, link)) {
        offerCode = candidate;
        break;
      }
    }
    if (offerCode === null) continue;
    applicableCodes.push(offerCode);
    assertSupported(offerCode);
    if (await sellerHasAvailableCrossSells(link.user_id as bigint))
      throw new HandBackToRails("compute_discount with cross-sells to apply optimistically");

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

    const quantity = eligible.reduce((sum, line) => sum + paramToI(line.quantity ?? ""), 0);
    const { minimum_quantity: minimum, max_purchase_count: max } = offerCode.row;
    const meetsMinimum = minimum == null || quantity >= minimum;
    const left = async () => {
      if (!remaining.has(offerCode!.id)) remaining.set(offerCode!.id, await offerCode!.quantityLeft(now));
      return remaining.get(offerCode!.id)!;
    };
    const sufficient = max == null || (await left()) >= quantity;

    // `offer_code.evaluate_for_buyer(buyer, product: link) unless returning_customer?(offer_code)`. With no buyer
    // that is nil for an existing-customers code or a tiered one that has no tier starting at month 0.
    const full = await fullDiscount(offerCode);
    let resolved: Record<string, unknown> | null;
    if (offerCode.row.new_customers_only && buyer !== null && (await returningCustomer(offerCode, buyer)))
      resolved = null;
    else if (offerCode.row.existing_customers_only || offerCode.tiered())
      resolved = await resolveForBuyer(offerCode, buyer, link, full, now);
    else resolved = full;

    if (resolved !== null && !offerCode.inactive(now) && meetsMinimum && sufficient) {
      if (max != null) remaining.set(offerCode.id, (await left()) - quantity);
      productsData[link.unique_permalink!] = resolved;
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
  // `normalize_code(params[:code])` calls `to_s`: an array or hash code is Ruby's to render.
  if (query.code !== undefined && typeof query.code !== "string")
    throw new HandBackToRails("compute_discount with a non-scalar code");
  const result = await processDiscount(normalizeCode(query.code ?? ""), cartLines(query), buyer, now);

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
