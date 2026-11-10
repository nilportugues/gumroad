// BestOfferCodeService#result and OfferCodeDiscountComputingService#process for one product and a visitor who is
// not signed in. A code that needs more (a buyer's purchase history, once-per-cart allocation, an option
// scope, two valid codes to weigh against each other) throws NotPortedError.
import { Prisma, type Link, type OfferCode } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { OfferCodeRecord } from "../models/offer-code.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import type { LinkRow } from "./product-reads.ts";

export const DEFAULT_SALE_LABEL = "Sale";
type Invalid = { valid: false; error_code: string };
type Valid = { valid: true; code: string; discount: Record<string, unknown> };
export type CodeResult = Invalid | Valid;

export const star = (name: string) => Prisma.raw(`\`${name}\`.*`);
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

// OfferCode.normalize_code
export const normalizeCode = (code: string) => code.normalize("NFC").trim().toLowerCase();

export const asRecord = (row: Record<string, unknown>) => new OfferCodeRecord(castRow<OfferCode>("OfferCode", row));

// OfferCode#is_currency_valid?
export const currencyValid = (code: OfferCodeRecord, product: LinkRow) =>
  code.row.amount_percentage != null ||
  code.row.currency_type == null ||
  product.price_currency_type === code.row.currency_type;

// OfferCode#applicable?
export async function applicable(code: OfferCodeRecord, product: LinkRow): Promise<boolean> {
  if (!code.row.universal) return (await code.products()).some((candidate) => candidate.id === product.id);
  if ((await code.excludedProducts()).some((candidate) => candidate.id === product.id)) return false;
  return present(code.row.currency_type) ? product.price_currency_type === code.row.currency_type : true;
}

// Link#find_offer_code(code:)
async function findOfferCode(product: LinkRow, code: string): Promise<OfferCodeRecord | null> {
  const [own] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} INNER JOIN ${table("offer_codes_products")} ON ${column("offer_codes", "id")} = ${column("offer_codes_products", "offer_code_id")} WHERE ${column("offer_codes_products", "product_id")} = ${product.id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "code")} = ${code} ORDER BY ${column("offer_codes", "id")} ASC LIMIT 1`,
  );
  if (own) return asRecord(own);
  const [universal] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${product.user_id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = 1 AND (${column("offer_codes", "currency_type")} = ${product.price_currency_type} OR ${column("offer_codes", "currency_type")} IS NULL) AND NOT EXISTS (SELECT 1 FROM ${table("offer_codes_excluded_products")} WHERE ${column("offer_codes_excluded_products", "offer_code_id")} = ${column("offer_codes", "id")} AND ${column("offer_codes_excluded_products", "product_id")} = ${product.id}) AND ${column("offer_codes", "code")} = ${code} ORDER BY ${column("offer_codes", "id")} ASC LIMIT 1`,
  );
  return universal ? asRecord(universal) : null;
}

const ruby = (date: Date | null) => (date ? date.toISOString() : null);

// OfferCode#option_ids_by_product
async function optionIdsByProduct(code: OfferCodeRecord): Promise<Record<string, string[]>> {
  const grouped = new Map<string, string[]>();
  for (const variant of await code.variants()) {
    const productId = await variant.owningProductId();
    if (productId === null) throw new NotPortedError("OfferCode#option_ids_by_product for an option with no product");
    const key = encrypt(productId);
    grouped.set(key, [...(grouped.get(key) ?? []), encrypt(variant.row.id)]);
  }
  return Object.fromEntries(grouped);
}

// OfferCode#discount, in full
export async function fullDiscount(code: OfferCodeRecord): Promise<Record<string, unknown>> {
  const { row } = code;
  const cents = row.amount_percentage == null;
  const json: Record<string, unknown> = cents
    ? { type: "fixed", cents: row.amount_cents }
    : { type: "percent", percents: row.amount_percentage };
  json.product_ids = row.universal ? null : (await code.products()).map((product) => encrypt(product.id));
  json.expires_at = ruby(row.expires_at);
  json.minimum_quantity = row.minimum_quantity;
  json.duration_in_billing_cycles = row.duration_in_months;
  json.minimum_amount_cents = row.minimum_amount_cents;
  if (row.universal) {
    const excluded = await code.excludedProducts();
    if (excluded.length > 0) json.excluded_product_ids = excluded.map((product) => encrypt(product.id));
  }
  if (await code.hasVariants()) json.option_ids_by_product = await optionIdsByProduct(code);
  if (row.new_customers_only) json.new_customers_only = true;
  if (row.amount_cents != null && code.oncePerCart) {
    json.once_per_cart = true;
    json.once_per_cart_id = encrypt(row.id);
    json.once_per_cart_amount_cents = row.amount_cents;
    json.once_per_cart_has_usage_limit = row.max_purchase_count != null;
  }
  return json;
}

function assertSupported(code: OfferCodeRecord): void {
  if (code.row.existing_customers_only)
    throw new NotPortedError("OfferCode#evaluate_for_buyer for an existing-customers code");
  if (code.tiered()) throw new NotPortedError("OfferCode#evaluate_for_buyer for a tiered code");
  if (code.oncePerCart) throw new NotPortedError("OfferCodeDiscountComputingService once-per-cart allocation");
}

// BestOfferCodeService#evaluate_code
async function evaluateCode(product: LinkRow, code: string | null, quantity: number, now: Date): Promise<CodeResult> {
  if (!present(code)) return { valid: false, error_code: "missing_code" };
  const normalized = normalizeCode(code);
  const found = await findOfferCode(product, normalized);
  if (!found) return { valid: false, error_code: "invalid_offer" };
  assertSupported(found);
  if (await found.hasVariants())
    throw new NotPortedError("OfferCode#applicable_to_variant? for a code limited to options");

  // OfferCodeDiscountComputingService: the user's alive codes with this code string, the first applicable one.
  const candidates = (
    await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${product.user_id} AND ${column("offer_codes", "code")} = ${normalized} AND ${column("offer_codes", "deleted_at")} IS NULL ORDER BY ${column("offer_codes", "id")} ASC`,
    )
  ).map(asRecord);
  let offerCode: OfferCodeRecord | null = null;
  for (const candidate of candidates) {
    if ((await applicable(candidate, product)) && currencyValid(candidate, product)) {
      offerCode = candidate;
      break;
    }
  }
  if (!offerCode) return { valid: false, error_code: "invalid_offer" };
  assertSupported(offerCode);
  if (await offerCode.hasVariants()) throw new NotPortedError("OfferCode#restricted_variants_for");

  const purchaseQuantity = Math.max(quantity, offerCode.row.minimum_quantity ?? 0);
  const inactive = offerCode.inactive(now);
  const meetsMinimum = offerCode.row.minimum_quantity == null || purchaseQuantity >= offerCode.row.minimum_quantity;
  let remaining: number | null = null;
  const sufficient = async () => {
    if (offerCode.row.max_purchase_count == null) return true;
    remaining ??= await offerCode.quantityLeft(now);
    return remaining >= purchaseQuantity;
  };
  if (!inactive && meetsMinimum && (await sufficient())) {
    return { valid: true, code, discount: await fullDiscount(offerCode) };
  }
  if (inactive) return { valid: false, error_code: "inactive" };
  if (!meetsMinimum) return { valid: false, error_code: "unmet_minimum_purchase_quantity" };
  return { valid: false, error_code: remaining! > 0 ? "insufficient_times_of_use" : "sold_out" };
}

export type DefaultOfferCodes = { codes: OfferCodeRecord[]; auto: OfferCodeRecord | null };

// User#auto_apply_offer_code_for(product) and BestOfferCodeService#default_offer_codes for an anonymous visitor.
export async function defaultOfferCodes(product: LinkRow): Promise<DefaultOfferCodes> {
  if (product.default_offer_code_id !== null)
    throw new NotPortedError("Link#effective_default_offer_code with an explicit default");
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${star("offer_codes")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${product.user_id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = 1 AND ${column("offer_codes", "auto_apply")} = 1 AND ${column("offer_codes", "new_customers_only")} = 0 ORDER BY ${column("offer_codes", "id")} ASC LIMIT 1`,
  );
  const code = row ? asRecord(row) : null;
  const auto = code && present(code.row.code) && (await applicable(code, product)) ? code : null;
  return { auto, codes: auto && currencyValid(auto, product) ? [auto] : [] };
}

// BestOfferCodeService#result
export async function bestOfferCodeResult(
  product: LinkRow,
  defaults: DefaultOfferCodes,
  urlCode: string | null,
  quantity: number,
  now = new Date(),
): Promise<CodeResult | null> {
  const url = present(urlCode) ? urlCode : null;
  const defaultCodes = defaults.codes.map((code) => code.row.code).filter(present);
  if (url === null && defaultCodes.length === 0) return null;
  const urlResult = await evaluateCode(product, url, quantity, now);
  let defaultResult: CodeResult | null = null;
  for (const code of defaultCodes) {
    const result = await evaluateCode(product, code, quantity, now);
    if (result.valid && defaultResult === null) defaultResult = result;
  }
  if (!urlResult.valid && defaultResult === null) return url !== null ? urlResult : null;
  if (urlResult.valid && defaultResult === null) return urlResult;
  if (!urlResult.valid) return defaultResult;
  throw new NotPortedError("BestOfferCodeService weighing a URL code against a default code");
}

// ProductProps#sale_label
export function saleLabel(result: CodeResult | null, auto: OfferCodeRecord | null): string | null {
  if (!result?.valid || auto === null) return null;
  if (normalizeCode(result.code).toLowerCase() !== (auto.row.code ?? "").toLowerCase()) return null;
  return present(auto.row.sale_label) ? auto.row.sale_label : DEFAULT_SALE_LABEL;
}

export type { Link };
