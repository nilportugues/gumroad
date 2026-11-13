// Checkout::DiscountsController#create and #update for a plain code (models/offer-code-writes.ts): products without options or tiers, no
// customer limits, no duration, no exclusions, one price per unit. Every check that decides a hand-back runs before the first statement,
// so a request Rails must take whole has changed nothing. What each save leaves behind is recorded in
// spec/requests/checkout_write_guards_parity_spec.rb.
import { Prisma, type Link, type OfferCode, type User } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import {
  addProduct,
  assertPlainCode,
  assertPlainProducts,
  buildOfferCode,
  loadOfferCode,
  OfferCodes,
  productsOfOfferCode,
  universalProducts,
} from "../models/offer-code-writes.ts";
import { OfferCodeFlags } from "../models/offer-code.ts";
import { column, selectRows, table } from "../models/sql.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { fetchOfferCodes, offerCodeProps } from "../presenters/discounts.ts";

import { blank, blankParam, castInteger, isHash, notPorted } from "./api-v2/ruby-params.ts";
import { type ActionResult } from "./application-controller.ts";
import { listingParams } from "./checkout-discounts.ts";
import type { MutationInput } from "./mutation.ts";
import type { Params } from "./rails-body.ts";
import { json } from "./seller-json.ts";

// The widest string the offer_codes columns hold; a longer one raises ActiveRecord::ValueTooLong in Rails.
const STRING_COLUMN_LIMIT = 255;
// `fetch_offer_codes` reads these from the same params; a request that carries them gets another page.
const LISTING_KEYS = ["page", "query", "sort", "column"];
// Params the dashboard form sends as lists of ids.
const ID_LIST_KEYS = ["selected_option_ids", "excluded_product_ids", "ownership_product_ids"];
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const MAX_SECOND = 59;
const FIRST_GREGORIAN_YEAR = 1600;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

type Attributes = Partial<OfferCode>;

const scalar = (value: unknown, what: string) => {
  if (Array.isArray(value) || isHash(value)) notPorted(`${what} that is a list or a hash`);
  return value;
};

// A string attribute: nil, or text that fits the column.
function text(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return notPorted(`${what} that is not text`);
  if (value.length > STRING_COLUMN_LIMIT) return notPorted(`${what} longer than its column`);
  return value;
}

// ActiveModel's Boolean cast, for the values the dashboard sends.
function flag(value: unknown, what: string): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return notPorted(`${what} that is not true or false`);
}

// An attribute assigned a timestamp string: ActiveModel's ISO 8601 cast of a whole-second time, read in UTC (config.time_zone is unset).
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.0+)?(Z|[-+]\d{2}(?::?\d{2})?)?$/u;
function timestamp(value: unknown, what: string): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return notPorted(`${what} that is not text`);
  if (value === "") return null;
  const match = TIMESTAMP.exec(value);
  if (match === null) return notPorted(`${what} the port cannot read`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const monthDays = month === 2 && leapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (
    year < FIRST_GREGORIAN_YEAR ||
    monthDays === undefined ||
    day < 1 ||
    day > monthDays ||
    hour > MAX_HOUR ||
    minute > MAX_MINUTE ||
    second > MAX_SECOND
  )
    return notPorted(`${what} that is not a time`);
  const zone = /^([-+])(\d{2}):?(\d{2})?$/u.exec(match[7] ?? "");
  const offset = zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * MINUTES_PER_HOUR + Number(zone[3] ?? 0)) : 0;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * MS_PER_MINUTE);
}

// A list of ids the form leaves empty: nothing to resolve, so the save touches no join table.
function assertNoIds(params: Params, key: string): void {
  const value = params[key];
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length > 0) notPorted(`a non-empty ${key}`);
}

// `current_seller.products.by_external_ids(ids)`: the seller's products (deleted ones included) whose id decrypts, in id order.
async function sellerProducts(seller: User, value: unknown): Promise<Link[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
    notPorted("selected_product_ids that are not a list of text");
  const ids = [...new Set((value as string[]).map((id) => decrypt(id)).filter((id): id is number => id !== null))];
  if (ids.length === 0) return [];
  return selectRows<Link>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "id")} IN (${Prisma.join(ids)}) ORDER BY ${column("links", "id")}`,
  );
}

// `clean_params` followed by the attributes `offer_code_params` permits. Only keys the request sent are assigned, except currency_type,
// which clean_params always writes.
export function readAttributes(params: Params): { attributes: Attributes; oncePerCart: boolean | undefined } {
  for (const key of LISTING_KEYS)
    if (params[key] !== undefined && params[key] !== null) notPorted("listing params on a write");
  for (const key of ID_LIST_KEYS) assertNoIds(params, key);
  const tiers = params.ownership_duration_tiers;
  if (tiers !== undefined && tiers !== null) notPorted("duration tiers");

  const effective: Params = {};
  for (const key of [
    "name",
    "code",
    "universal",
    "max_purchase_count",
    "amount_cents",
    "amount_percentage",
    "valid_at",
    "expires_at",
    "minimum_quantity",
    "duration_in_billing_cycles",
    "minimum_amount_cents",
    "existing_customers_only",
    "new_customers_only",
    "once_per_cart",
    "auto_apply",
    "sale_label",
    "currency_type",
  ])
    if (key in params) effective[key] = scalar(params[key], key);

  const currency = effective.currency_type;
  if (currency === undefined || currency === null || (typeof currency === "string" && blank(currency)))
    effective.currency_type = null;
  for (const key of ["amount_percentage", "amount_cents"])
    if (typeof effective[key] === "boolean") notPorted("an amount that is a boolean");
  if (!blankParam(effective.amount_percentage)) {
    effective.amount_cents = null;
    effective.currency_type = null;
    effective.once_per_cart = false;
  } else if ("amount_cents" in effective) effective.amount_percentage = null;

  const attributes: Attributes = {};
  const assign = <K extends keyof Attributes>(key: K, read: (value: unknown) => Attributes[K]) => {
    if (key in effective) attributes[key] = read(effective[key]);
  };
  assign("name", (value) => text(value, "name"));
  assign("code", (value) => text(value, "code"));
  assign("sale_label", (value) => text(value, "sale_label"));
  assign("currency_type", (value) => text(value, "currency_type"));
  assign("max_purchase_count", castInteger);
  assign("minimum_quantity", castInteger);
  assign("minimum_amount_cents", castInteger);
  assign("amount_cents", castInteger);
  assign("amount_percentage", castInteger);
  assign("valid_at", (value) => timestamp(value, "valid_at"));
  assign("expires_at", (value) => timestamp(value, "expires_at"));
  assign("auto_apply", (value) => (value === null ? null : flag(value, "auto_apply")) as boolean);
  assign("universal", (value) => flag(value, "universal"));
  if ("duration_in_billing_cycles" in effective && castInteger(effective.duration_in_billing_cycles) !== null)
    notPorted("a duration in billing cycles");
  for (const key of ["existing_customers_only", "new_customers_only"])
    if (key in effective && flag(effective[key], key)) notPorted(`a code with ${key}`);

  let oncePerCart: boolean | undefined;
  if ("once_per_cart" in effective) {
    oncePerCart = flag(effective.once_per_cart, "once_per_cart");
    // The per-cart rule changes how a fixed amount is split across the cart.
    if (oncePerCart) notPorted("a code applied once per cart");
  }
  return { attributes, oncePerCart };
}

// What the first page of the list shows, rendered before the write: a code the page cannot render (props the port refuses) must not be
// found after the save. The page after the write is the saved code plus the first nine of these.
async function renderableList(seller: User, sellerContext: SellerContext) {
  const listing = await fetchOfferCodes(seller, listingParams({}));
  listing.codes.map((code) => offerCodeProps(code, seller, sellerContext));
}

async function savedList(seller: User, sellerContext: SellerContext): Promise<ActionResult> {
  const listing = await fetchOfferCodes(seller, listingParams({}));
  return json({
    success: true,
    offer_codes: listing.codes.map((code) => offerCodeProps(code, seller, sellerContext)),
    pagination: listing.pagination,
  });
}

const failure = (record: { errors: { fullMessages(): string[] } }): ActionResult =>
  json({ success: false, error_message: record.errors.fullMessages()[0] });

export async function createDiscount(input: MutationInput, sellerContext: SellerContext): Promise<ActionResult> {
  const seller = sellerContext.seller!;
  const { params } = input;
  const { attributes } = readAttributes(params);
  const universal = attributes.universal ?? false;
  const products = await sellerProducts(seller, params.selected_product_ids);
  if (universal && products.length > 0) notPorted("a code for all products that also names some");
  await assertPlainProducts(
    universal ? await universalProducts(seller.id, attributes.currency_type ?? null) : products,
  );
  await renderableList(seller, sellerContext);

  const record = buildOfferCode({ ...attributes, user_id: Number(seller.id) });
  // `build(products:)` assigns the list before anything else, and each product queues its reindex at once.
  for (const product of products) await addProduct(record, product);
  if (!(await OfferCodes.save(record))) return failure(record);
  return savedList(seller, sellerContext);
}

// What `update` assigns: `code` never changes, and the product lists must stay as they are.
async function planUpdate(input: MutationInput, row: OfferCode, seller: User): Promise<Attributes> {
  const { params } = input;
  if (row.deleted_at !== null) notPorted("an update of a deleted code");
  await assertPlainCode(row);
  const [defaults] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("links")} WHERE ${column("links", "default_offer_code_id")} = ${row.id}) AS found`,
  );
  if (Number(defaults?.found ?? 0) > 0) notPorted("an update of the default discount of a product");

  const { attributes, oncePerCart } = readAttributes(params);
  // `params.key?(:ownership_duration_tiers)` with a nil assigns nil, which changes a stored empty list.
  if ("ownership_duration_tiers" in params && row.ownership_duration_tiers !== null)
    notPorted("duration tiers on the code");
  delete attributes.code;
  if (attributes.universal !== undefined) {
    if (attributes.universal !== row.universal) notPorted("a switch between all products and some");
    delete attributes.universal;
  }
  if (oncePerCart !== undefined) attributes.flags = OfferCodeFlags.set(row.flags, "once_per_cart", oncePerCart);

  if ("selected_product_ids" in params) {
    const requested = new Set(
      (await sellerProducts(seller, params.selected_product_ids)).map((product) => String(product.id)),
    );
    const current = new Set((await productsOfOfferCode(row.id)).map((product) => String(product.id)));
    if (requested.size !== current.size || [...requested].some((id) => !current.has(id)))
      notPorted("a change of the products of a code");
  }
  const applicable = row.universal
    ? await universalProducts(
        row.user_id,
        "currency_type" in attributes ? (attributes.currency_type ?? null) : row.currency_type,
      )
    : await productsOfOfferCode(row.id);
  await assertPlainProducts(applicable);
  return attributes;
}

export async function updateDiscount(
  input: MutationInput,
  row: OfferCode,
  sellerContext: SellerContext,
): Promise<ActionResult> {
  const seller = sellerContext.seller!;
  const attributes = await planUpdate(input, row, seller);
  await renderableList(seller, sellerContext);

  const record = loadOfferCode(row);
  if (!(await OfferCodes.update(record, attributes))) return failure(record);
  return savedList(seller, sellerContext);
}
