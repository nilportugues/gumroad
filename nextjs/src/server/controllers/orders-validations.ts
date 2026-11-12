// OrdersController#create (POST /orders) for the requests Rails refuses before it writes a row or calls a processor:
//   - a bot (`{ success: true }`), a cart above Cart::MAX_ALLOWED_CART_PRODUCTS, a request without line items;
//   - Order::CreateService's cart checks: a blank or repeated uid, a permalink that matches no product;
//   - a signed-out buyer whose email Purchase#must_have_valid_email refuses, for a plain one-time USD product. The purchase fails
//     its first `save` on validation, so no purchase, order, event or job is created (recorded: no `db` rows, no `jobs`, no `http`).
//
// Everything else hands the request back to Rails whole, before any write: a line that would be saved (a valid email, whatever
// the product's availability, price or stock), every product shape or line parameter this does not model (variants, tiers,
// pay-what-you-want, other currencies, gifts, discounts, tips, custom fields, shipping, bundles, preorders, free trials,
// installments, upsells), a signed-in buyer, and any request that reaches reCAPTCHA verification (a Google call; Rails'
// test environment skips it, so only an environment with no key configured is answered here).
import { Prisma } from "@prisma/client";

import { railsLoggedInUser } from "../auth/resolve.ts";
import { isBot } from "../infra/bots.ts";
import { getConfig } from "../infra/config.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { formattedPrice } from "../models/concerns/money-formatter.ts";
import { LinkFlags } from "../models/link.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { checkoutProduct } from "../presenters/checkout-product.ts";
import type { LinkRow } from "../presenters/product-reads.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json } from "./json-actions.ts";
import { registerMutations, remoteIp, type MutationInput } from "./mutation.ts";
import { freeOrderResponse } from "./orders-free-purchase.ts";

// Cart::MAX_ALLOWED_CART_PRODUCTS
const MAX_ALLOWED_CART_PRODUCTS = 50;
// Purchase::MAX_PRICE_RANGE
const MAX_PRICE = 2_147_483_647;
const MIN_PRICE = -MAX_PRICE;
const INVALID_CART_MESSAGE = "The cart data is invalid. Please refresh and try again.";
const PRODUCT_NOT_FOUND_MESSAGE = "Product not found";
const INVALID_EMAIL_MESSAGE = "valid email required";
// Native types whose purchases carry more than the product's price (see the file header).
const SIMPLE_NATIVE_TYPES_EXCLUDED = new Set(["call", "commission", "coffee", "membership", "bundle"]);
// The line keys that cannot change what a refused purchase answers. Anything else sends the request to Rails.
const HARMLESS_LINE_KEYS = new Set([
  "uid",
  "permalink",
  "perceived_price_cents",
  "quantity",
  "affiliate_id",
  "referrer",
  "price_range",
  "discount_code",
]);
// Order params that would make the first save depend on more than the email.
const UNMODELLED_ORDER_KEYS = [
  "is_gift",
  "giftee_email",
  "giftee_id",
  "gift_note",
  "hide_gifter",
  "buyer_currency_quote",
  "payment_details_source",
  "payment_element_mount_currency",
  "payment_method_list_token",
  "direct_listed_amount_token",
  "confirmation_token",
  "vat_id",
  "referrer",
  "url_parameters",
];

type Line = Record<string, unknown>;

const handBack = (reason: string): never => {
  throw new HandBackToRails(`orders ${reason}`);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// `value.blank?` for a JSON scalar.
const blank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  (typeof value === "string" && /^[\s\u0085]*$/u.test(value));

// ActionController::Parameters#values for an object, the array itself otherwise (OrdersController#normalize_line_items).
function lineItems(params: MutationInput["params"]): Line[] {
  const raw = params.line_items;
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.values(raw)
      : handBack("with line items that are neither a list nor an object");
  return items.map((item) => (isObject(item) ? item : handBack("with a line item that is not an object")));
}

// OrdersController#error_response / Order::ResponseHelpers#error_response without a purchase.
const errorResponse = (message: string) => ({
  success: false,
  error_message: message,
  permalink: null,
  name: null,
  formatted_price: "$0",
  error_code: null,
  is_tax_mismatch: false,
  card_country: null,
  ip_country: null,
  updated_product: null,
});

// OrdersController#skip_recaptcha?, for the environments where nothing is verified: development and test with no key configured.
// Production verifies against Google (or skips for an all-free cart of reviewed sellers, which this does not model).
function recaptchaSkipped(): boolean {
  const env = railsEnv();
  if (env !== "development" && env !== "test") return false;
  const keys = [getConfig("RECAPTCHA_MONEY_SITE_KEY"), getConfig("RECAPTCHA_MONEY_SCORE_SITE_KEY")];
  return keys.every((key) => key === undefined || key.trim() === "");
}

async function findLinkByPermalink(permalink: string): Promise<LinkRow | null> {
  const [row] = await selectRows<LinkRow>(
    Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

// `User.alive.where(email: params[:email]).none?`
async function emailHasNoAccount(email: unknown): Promise<boolean> {
  if (email !== undefined && email !== null && typeof email !== "string")
    return handBack("with an email that is not text");
  const condition =
    email === undefined || email === null
      ? Prisma.sql`${column("users", "email")} IS NULL`
      : Prisma.sql`${column("users", "email")} = ${email}`;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("users")} WHERE ${column("users", "deleted_at")} IS NULL AND ${condition} LIMIT 1`,
  );
  return rows.length === 0;
}

// EmailFormatValidator::EMAIL_REGEX (an /x regexp), over printable ASCII only: the characters whose Ruby and JavaScript
// readings of `\s`, `$` and the character classes agree, and which Purchase's `stripped_fields :email` leaves alone.
const EMAIL_REGEX =
  /^(?=.{3,255}$)(?:[^@\s()[\],.<>;:\\"]+(?:\.[^@\s()[\],.<>;:\\"]+)*|".+")@(?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\]|(?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,})$/u;
const PRINTABLE_ASCII_WITHOUT_SPACE = /^[!-~]*$/u;

// Whether Purchase#must_have_valid_email refuses the `email` param; an address this cannot judge hands the request back.
export function emailIsInvalid(email: unknown): boolean {
  if (email === undefined || email === null || email === "") return true;
  if (typeof email !== "string") return handBack("with an email that is not text");
  // Purchase's `stripped_fields :email` runs before the validation, so padding does not make an address invalid.
  const stripped = email.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
  if (!PRINTABLE_ASCII_WITHOUT_SPACE.test(stripped))
    return handBack("with an email holding spaces or non-ASCII characters");
  return !EMAIL_REGEX.test(stripped);
}

// An Integer for a JSON number or a string of digits; Ruby's `to_i` on anything else is not modelled.
function wholeNumber(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,15}$/u.test(value)) return Number(value);
  return handBack(`with a ${name} that is not a whole number`);
}

// The product shapes whose refused purchase answers with nothing but the product's price (see the file header).
async function plainOneTimeProduct(row: LinkRow, ip: string | null) {
  const flag = (name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(row.flags, name);
  if (
    flag("is_recurring_billing") ||
    flag("free_trial_enabled") ||
    flag("is_in_preorder_state") ||
    flag("is_physical") ||
    flag("is_bundle") ||
    flag("is_tiered_membership") ||
    Boolean(row.require_shipping) ||
    SIMPLE_NATIVE_TYPES_EXCLUDED.has(String(row.native_type)) ||
    row.customizable_price ||
    String(row.price_currency_type).toLowerCase() !== "usd" ||
    row.default_offer_code_id !== null ||
    (row.purchase_type !== null && row.purchase_type !== 0)
  )
    return handBack("for a product that is not a plain one-time USD product");
  let item;
  try {
    item = await checkoutProduct(row, { ip });
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  if (item.product.options.length > 0 || item.product.custom_fields.length > 0 || item.product.pwyw !== null)
    return handBack("for a product with options, custom fields or a customizable price");
  return item;
}

async function create(input: MutationInput): Promise<ActionResult> {
  const { params, request } = input;
  const lines = lineItems(params);

  // validate_order_request
  // A render in a before_action halts the chain: the after_actions (XSRF-TOKEN) do not run.
  if (isBot(request.headers.get("user-agent"), params.user_agent_bot))
    return { ...json({ success: true }), rescued: true };
  if (lines.length > MAX_ALLOWED_CART_PRODUCTS)
    return {
      ...json(errorResponse(`You cannot add more than ${MAX_ALLOWED_CART_PRODUCTS} products to the cart.`)),
      rescued: true,
    };
  // The guid cookie is minted for a request without one; a present but empty one would refuse a paid order, which no recording shows.
  if (request.cookies.get("_gumroad_guid") === "") return handBack("with an empty guid cookie");
  if (!recaptchaSkipped()) return handBack("that reaches reCAPTCHA verification");

  const signedIn = railsLoggedInUser(input.context) !== null;
  const canBuyerSignUp = !signedIn && (await emailHasNoAccount(params.email));

  // Order::CreateService#perform
  const uids = lines.map((line) => {
    const uid = line.uid;
    if (uid !== undefined && uid !== null && typeof uid !== "string") return handBack("with a uid that is not text");
    return uid ?? null;
  });
  const responses: Record<string, unknown> = {};
  if (uids.some((uid) => uid === null || blank(uid)) || new Set(uids).size !== uids.length) {
    for (const uid of new Set(uids)) responses[uid ?? ""] = errorResponse(INVALID_CART_MESSAGE);
    return json({ success: true, line_items: responses, offer_codes: [], can_buyer_sign_up: canBuyerSignUp });
  }

  const found: { line: Line; uid: string; row: LinkRow | null }[] = [];
  for (const [index, line] of lines.entries()) {
    const permalink = line.permalink;
    if (permalink !== undefined && permalink !== null && typeof permalink !== "string")
      return handBack("with a permalink that is not text");
    found.push({
      line,
      uid: uids[index]!,
      row: typeof permalink === "string" ? await findLinkByPermalink(permalink) : null,
    });
  }

  // A single line that would be saved (a valid email) is written here when it is a plain free product, else Rails takes it
  const [only] = found;
  if (found.length === 1 && only!.row !== null && !blank(params.email) && !emailIsInvalid(params.email))
    return freeOrderResponse(input, only!.line, only!.row, canBuyerSignUp);

  const ip = remoteIp(request);
  const ipCountry = geoIpLookup(ip)?.countryName ?? null;
  for (const { line, uid, row } of found) {
    if (row === null) {
      responses[uid] = errorResponse(PRODUCT_NOT_FOUND_MESSAGE);
      continue;
    }
    responses[uid] = await refusedPurchase(input, line, row, signedIn, ipCountry);
  }
  return json({ success: true, line_items: responses, offer_codes: [], can_buyer_sign_up: canBuyerSignUp });
}

// A line whose purchase fails its first validation on the email. Anything else would be saved, so Rails takes the request.
async function refusedPurchase(
  input: MutationInput,
  line: Line,
  row: LinkRow,
  signedIn: boolean,
  ipCountry: string | null,
) {
  const { params } = input;
  if (signedIn) return handBack("from a signed-in buyer");
  for (const key of Object.keys(line))
    if (!HARMLESS_LINE_KEYS.has(key)) return handBack(`with a line parameter (${key}) that is not modelled`);
  for (const key of UNMODELLED_ORDER_KEYS)
    if (!blank(params[key])) return handBack(`with an order parameter (${key}) that is not modelled`);
  for (const key of ["discount_code", "price_range"]) if (!blank(line[key])) return handBack(`with a line ${key}`);

  const quantity = wholeNumber(line.quantity, "quantity");
  if (quantity !== null && quantity !== 1) return handBack("with a quantity other than 1");
  // Purchase::CreateService#validate_perceived_price and #validate_zip_code raise before the purchase is built.
  const perceived = wholeNumber(line.perceived_price_cents, "perceived price");
  if (perceived !== null && (perceived < MIN_PRICE || perceived > MAX_PRICE))
    return handBack("with a price outside Purchase::MAX_PRICE_RANGE");
  const billing = params.purchase;
  const billingCountry = isObject(billing) ? billing.country : undefined;
  if (billing !== undefined && billing !== null && !isObject(billing))
    return handBack("with a purchase that is not an object");
  const country = blank(billingCountry) ? params.tax_country_election : billingCountry;
  if (!blank(country) && (typeof country !== "string" || country === "US"))
    return handBack("with a US or unreadable country");
  if (!emailIsInvalid(params.email)) return handBack("with an email that would be accepted");

  // CheckoutPresenter#checkout_product for the purchase's own ip, on the cart item of the product's listed price.
  const item = await plainOneTimeProduct(row, remoteIp(input.request));
  return {
    success: false,
    error_message: INVALID_EMAIL_MESSAGE,
    permalink: row.unique_permalink,
    name: row.name,
    formatted_price: formattedPrice("usd", item.price),
    error_code: null,
    is_tax_mismatch: false,
    card_country: null,
    ip_country: ipCountry,
    updated_product: item,
  };
}

registerMutations({
  method: "POST",
  pattern: "/orders",
  formats: ["any"],
  run: (input) => create(input),
});
