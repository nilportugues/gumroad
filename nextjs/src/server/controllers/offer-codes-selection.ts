// OfferCodesController#selection_discounts (app/controllers/offer_codes_controller.rb) and ProductProps#selection_discounts: the code
// each option would get on the product page, as BestOfferCodeService quotes it for the signed-in buyer or a visitor.
//
// Handed to Rails whole: a product with an explicit default offer code, a URL code that wins against a default code only by the
// price comparison (needs the cart item's price and stock), an offer the discount computation would answer with no entry for the
// product (Rails raises on it), and an integer too large for a JS number.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import {
  defaultOfferCodes,
  findOfferCode,
  normalizeCode,
  saleLabel,
  star,
  type CodeResult,
} from "../presenters/best-offer-code.ts";
import { selectionOptions } from "../presenters/product-props.ts";
import type { LinkRow } from "../presenters/product-reads.ts";
import { esJson, type JsonValue } from "../search/es-json.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { processDiscount } from "./offer-codes.ts";
import { requestFormat } from "./rails-params.ts";

// BasePrice::Recurrence::ALLOWED_RECURRENCES
const ALLOWED_RECURRENCES = ["monthly", "quarterly", "biannually", "yearly", "every_two_years"];
// A digit string past this length no longer survives the trip through a JS number.
const MAX_SAFE_DIGITS = 15;

// OfferCodesController#scalar_param: a repeated or nested query key reads as absent.
const scalarParam = (input: MutationInput, key: string): string | undefined => {
  const value = input.params[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

// OfferCodesController#integer_param
function integerParam(input: MutationInput, key: string): number | undefined {
  const value = scalarParam(input, key);
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  if (value.replace(/^0+/u, "").length > MAX_SAFE_DIGITS)
    throw new HandBackToRails("an integer too large for a JS number");
  return Number(value);
}

// BestOfferCodeService#evaluate_code and #compute_code: the code through OfferCodeDiscountComputingService, with the option
// as the only line.
async function evaluate(
  product: LinkRow,
  code: string | undefined,
  quantity: number,
  buyer: User | null,
  optionId: string,
  now: Date,
): Promise<CodeResult> {
  if (code === undefined) return { valid: false, error_code: "missing_code" };
  const normalized = normalizeCode(code);
  const found = await findOfferCode(product, normalized);
  if (found === null) return { valid: false, error_code: "invalid_offer" };

  const permalink = product.unique_permalink!;
  const line = {
    permalink,
    quantity: String(Math.max(quantity, found.row.minimum_quantity ?? 0)),
    ...(optionId === "" ? {} : { variant_external_id: optionId }),
  };
  const response = await processDiscount(normalized, { [permalink]: line }, buyer, now);
  if (response.error_code !== null) return { valid: false, error_code: response.error_code };
  const discount = response.products_data[permalink];
  if (discount === undefined)
    throw new HandBackToRails("an offer with no discount for the product, which Rails raises on");
  return { valid: true, code, discount };
}

// BestOfferCodeService#result, for the codes it can settle without weighing two valid ones.
async function quote(
  product: LinkRow,
  defaults: Awaited<ReturnType<typeof defaultOfferCodes>>,
  urlCode: string | undefined,
  quantity: number,
  buyer: User | null,
  optionId: string,
  now: Date,
): Promise<CodeResult | null> {
  const defaultCodes = defaults.codes
    .map((code) => code.row.code)
    .filter((code): code is string => code != null && code.trim() !== "");
  if (urlCode === undefined && defaultCodes.length === 0) return null;
  const urlResult = await evaluate(product, urlCode, quantity, buyer, optionId, now);
  let defaultResult: CodeResult | null = null;
  for (const code of defaultCodes) {
    const result = await evaluate(product, code, quantity, buyer, optionId, now);
    if (result.valid && defaultResult === null) defaultResult = result;
  }
  if (!urlResult.valid && defaultResult === null) return urlCode !== undefined ? urlResult : null;
  if (urlResult.valid && defaultResult === null) return urlResult;
  if (!urlResult.valid) return defaultResult;
  throw new NotPortedError("BestOfferCodeService weighing a URL code against a default code");
}

export async function selectionDiscounts(input: MutationInput): Promise<ActionResult> {
  const format = requestFormat(input.request);
  if (format === "other") throw new HandBackToRails("a request whose format is neither HTML nor JSON");
  const permalink = scalarParam(input, "permalink");
  const [product] =
    permalink === undefined
      ? []
      : await selectRows<LinkRow>(
          Prisma.sql`SELECT ${star("links")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
        );
  // `head :not_found` names the content type of the format asked for.
  if (product === undefined)
    return {
      status: 404,
      body: "",
      contentType: format === "json" ? "application/json" : "text/html",
      paramsRead: true,
    };

  const recurrenceParam = scalarParam(input, "recurrence");
  const recurrence =
    recurrenceParam !== undefined && ALLOWED_RECURRENCES.includes(recurrenceParam) ? recurrenceParam : null;
  const quantity = Math.max(integerParam(input, "quantity") ?? 0, 1);
  const urlCode = scalarParam(input, "code");
  const optionIdParam = scalarParam(input, "option_id");
  const inputs = {
    url_code: urlCode ?? null,
    quantity,
    recurrence,
    option_id: optionIdParam ?? null,
    price_cents: integerParam(input, "price_cents") ?? null,
  };
  const buyer = railsLoggedInUser(input.context);
  const defaults = await defaultOfferCodes(product);
  const respond = (selection: Record<string, unknown>): ActionResult => ({
    status: 200,
    body: esJson(selection as JsonValue),
    contentType: "application/json; charset=utf-8",
    paramsRead: true,
  });
  if (urlCode === undefined && defaults.codes.length === 0)
    return respond({ ...inputs, options: {}, rent_options: null });

  const now = new Date();
  const { optionIds, rental } = await selectionOptions(product);
  const quotes = async () => {
    const entries: [string, unknown][] = [];
    for (const optionId of optionIds) {
      const result = await quote(product, defaults, urlCode, quantity, buyer, optionId, now);
      entries.push([optionId, { discount_code: result, sale_label: saleLabel(result, defaults.auto) }]);
    }
    return Object.fromEntries(entries);
  };
  const options = await quotes();
  return respond({ ...inputs, options, rent_options: rental && !rental.rent_only ? options : null });
}

registerMutations({
  method: "GET",
  pattern: "/offer_codes/selection_discounts",
  formats: ["html", "json"],
  skipForgeryProtection: true,
  run: selectionDiscounts,
});
