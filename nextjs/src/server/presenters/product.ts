// ProductPresenter, ported for the products whose pricing and inventory this port can prove: `card_for_web`
// (ProductPresenter::Card) is the canonical card every listing surface renders. What it cannot prove throws
// NotPortedError, naming the Rails code that answers it; callers that must not 500 check `supports()` first.
//
// Goldens: __fixtures__/product-presenter.golden.json, written by spec/presenters/product_presenter_golden_spec.rb
// from the real presenter over one database (seeded by product.test.ts).
import { Prisma } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { rubyRound } from "../models/concerns/ruby-numeric.ts";
import { toQuery, type Query } from "../controllers/rails-query.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";
import { avatarUrl, displayName } from "../page-props/signed-in/presenters.ts";
import { thumbnailOrCoverUrl } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { encrypt } from "../../lib/obfuscate-ids.ts";
import { jsonDataForAttr, Users } from "../models/user.ts";
import { plaintextDescription, RUBY_SPACE } from "./description.ts";
import { toHash } from "../models/concerns/json-data.ts";
import { rubyJsonParse } from "../models/concerns/serialized-columns.ts";
import {
  alivePrices,
  bit,
  currentBaseVariants,
  findLink,
  findUserById,
  type LinkRow,
  type PriceRow,
  reviewStat,
  userByDomain,
  type UserRow,
} from "./product-reads.ts";
import type { User } from "@prisma/client";

export const DESCRIPTION_MAX_LENGTH = 100;
const PURCHASE_TYPES = ["buy_only", "rent_only", "buy_and_rent"] as const;
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"] as const;
// Link flag positions (models/link.ts LinkFlags).
const FLAG = { is_recurring_billing: 2, is_tiered_membership: 19, is_bundle: 26, display_product_reviews: 17, customizable_flag: 0 } as const;
const OMISSION = "...";
// [[:punct:][:space:]]+\z: Onigmo's Unicode punctuation also covers the ASCII symbols below.
const TRAILING_PUNCT_OR_SPACE = new RegExp(`(?:[\\p{P}$+<=>^\`|~]|${RUBY_SPACE})+$`, "u");

// The request fields a card reads: ActionDispatch::Request#host, #host_with_port, #protocol.
export type PresenterRequest = { host: string; hostWithPort: string; protocol: string; remoteIp: string; params: Record<string, string>; cookies: Map<string, string | null> };

export type CardOptions = {
  request?: PresenterRequest | null;
  recommendedBy?: string | null;
  recommenderModelName?: string | null;
  target?: string | null;
  showSeller?: boolean;
  affiliateId?: string | null;
  query?: string | null;
  offerCode?: string | null;
  computeDescription?: boolean;
  computeInventory?: boolean;
  descriptionMaxLength?: number;
};

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

const link = {
  purchaseType: (row: LinkRow) => PURCHASE_TYPES[row.purchase_type ?? -1] ?? null,
  subscriptionDuration: (row: LinkRow) => SUBSCRIPTION_DURATIONS[row.subscription_duration ?? -1] ?? null,
  isRecurring: (row: LinkRow) => bit(row.flags, FLAG.is_recurring_billing),
  isTiered: (row: LinkRow) => bit(row.flags, FLAG.is_tiered_membership),
  isBundle: (row: LinkRow) => bit(row.flags, FLAG.is_bundle),
  displaysReviews: (row: LinkRow) => bit(row.flags, FLAG.display_product_reviews),
  generalPermalink: (row: LinkRow) => (present(row.custom_permalink) ? row.custom_permalink : row.unique_permalink),
  externalId: (row: LinkRow) => encrypt(row.id),
  currency: (row: LinkRow) => (row.price_currency_type ?? "").toLowerCase(),
};
export { link as linkFields };

const isRental = (price: PriceRow) => bit(price.flags, 1);

function hash(raw: unknown) {
  if (typeof raw !== "string") return null;
  return toHash(rubyJsonParse(raw));
}

// -------------------------------------------------------------------------------------------------
// Pricing (Product::Prices) for products that are not tiered memberships

// `tierPrice` is the price of a tiered membership: Product::Prices#lowest_tier_price for the default duration.
type PricedProduct = { link: LinkRow; prices: PriceRow[]; priceDifference: number | null; tierPrice?: number };

function pricesForCurrency(prices: PriceRow[], row: LinkRow): PriceRow[] {
  return prices.filter((price) => price.currency === row.price_currency_type);
}

function rentalPriceCents(product: PricedProduct): number | null {
  const type = link.purchaseType(product.link);
  if (type !== "rent_only" && type !== "buy_and_rent") return null;
  return pricesForCurrency(product.prices, product.link).filter(isRental).at(-1)?.price_cents ?? null;
}

function buyPriceCents(product: PricedProduct): number | null {
  const type = link.purchaseType(product.link);
  if (type !== "buy_only" && type !== "buy_and_rent") return null;
  let relevant = pricesForCurrency(product.prices, product.link).filter((price) => !isRental(price));
  const duration = link.subscriptionDuration(product.link);
  if (link.isRecurring(product.link) && duration !== null) relevant = relevant.filter((price) => price.recurrence === duration);
  return relevant.at(-1)?.price_cents ?? null;
}

// Product::Prices#default_price_cents
const defaultPriceCents = (product: PricedProduct) => (link.purchaseType(product.link) === "rent_only" ? rentalPriceCents(product) : buyPriceCents(product));

// Product::Prices#display_price_cents (not tiered)
const displayPriceCents = (product: PricedProduct) => product.tierPrice ?? (defaultPriceCents(product) ?? 0) + (product.priceDifference ?? 0);

async function pricedProduct(row: LinkRow): Promise<PricedProduct> {
  if (link.isTiered(row)) {
    const { lowestTierPriceCents } = await import("./product-props.ts");
    return { link: row, prices: await alivePrices(row.id), priceDifference: null, tierPrice: await lowestTierPriceCents(row, true) };
  }
  const variants = await currentBaseVariants(row.id);
  const differences = variants.map((variant) => variant.price_difference_cents).filter((cents): cents is number => cents !== null);
  return { link: row, prices: await alivePrices(row.id), priceDifference: differences.length === 0 ? null : Math.min(...differences) };
}

// Link#effective_default_offer_code is nil: no default offer code and no seller-wide sale. A discounted card
// price needs OfferCode#applicable?, usage limits and variant scopes (Product::Prices#discounted_price_cents).
async function assertNoDefaultDiscount(row: LinkRow): Promise<void> {
  if (row.default_offer_code_id !== null) throw new NotPortedError("Product::Prices#discounted_price_cents with a default offer code");
  const [sale] = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("offer_codes")} WHERE ${column("offer_codes", "user_id")} = ${row.user_id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = TRUE AND ${column("offer_codes", "auto_apply")} = TRUE LIMIT 1`,
  );
  if (sale) throw new NotPortedError("Product::Prices#discounted_price_cents with an auto-applied offer code");
}

// Link#remaining_for_sale_count
async function remainingForSaleCount(row: LinkRow): Promise<number | null> {
  return (await import("./product-props.ts")).remainingForSaleCount(row);
}

// -------------------------------------------------------------------------------------------------
// URLs

type UrlOptions = Record<string, string | null | undefined>;

// ActionDispatch's url_for query: nil and blank values are dropped, keys sorted, CGI-escaped.
function queryString(options: UrlOptions): string {
  const query: Query = {};
  for (const [key, value] of Object.entries(options)) if (value != null && value !== "") query[key] = value;
  const parts = toQuery(query);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

const protocolOf = () => domainConfig(process.env).protocol;

// User#subdomain_with_protocol
export function subdomainWithProtocol(user: Pick<UserRow, "username">): string | null {
  if (!present(user.username)) return null;
  const config = domainConfig(process.env);
  return `${config.protocol}://${user.username.replaceAll("_", "-")}.${config.rootDomain}`;
}

// Link#long_url
export function longUrl(row: LinkRow, seller: UserRow, options: { recommendedBy?: string | null; recommenderModelName?: string | null; layout?: string | null; affiliateId?: string | null; query?: string | null; code?: string | null; autocomplete?: boolean; host?: string | null } = {}): string {
  const config = domainConfig(process.env);
  const host = options.host ?? subdomainWithProtocol(seller) ?? `${config.protocol}://${config.domain}`;
  const query = queryString({
    recommended_by: options.recommendedBy,
    recommender_model_name: options.recommenderModelName,
    layout: options.layout,
    query: options.query,
    affiliate_id: options.affiliateId,
    code: options.code,
    autocomplete: options.autocomplete ? "true" : null,
  });
  return `${host}/l/${encodeURIComponent(link.generalPermalink(row)!)}${query}`;
}

// ProductsHelper#url_for_product_page
async function urlForProductPage(row: LinkRow, seller: UserRow, request: PresenterRequest | null | undefined, options: CardOptions): Promise<string> {
  const code = present(options.offerCode) ? options.offerCode : null;
  if (request && (await userByDomain(request.host))?.id === seller.id) {
    return `${request.protocol}${request.hostWithPort}/l/${encodeURIComponent(link.generalPermalink(row)!)}${queryString({
      code,
      recommended_by: options.recommendedBy,
      recommender_model_name: options.recommenderModelName,
      layout: options.target,
      affiliate_id: options.affiliateId,
      query: options.query,
    })}`;
  }
  return longUrl(row, seller, { code, recommendedBy: options.recommendedBy, recommenderModelName: options.recommenderModelName, layout: options.target, affiliateId: options.affiliateId });
}

// -------------------------------------------------------------------------------------------------
// Seller

// UserPresenter#author_byline_props
export async function authorBylineProps(seller: UserRow, { recommendedBy = null, customDomainUrl = null }: { recommendedBy?: string | null; customDomainUrl?: string | null } = {}) {
  if (!present(seller.username)) return null;
  const base = customDomainUrl ?? subdomainWithProtocol(seller)!;
  return {
    id: seller.external_id,
    name: displayName(seller as unknown as User),
    avatar_url: await avatarUrl(seller as unknown as User),
    // URI#query= with { recommended_by: }.to_query
    profile_url: present(recommendedBy) ? `${base}${queryString({ recommended_by: recommendedBy })}` : base,
    is_verified: !!seller.verified,
  };
}

// -------------------------------------------------------------------------------------------------
// Buyer currency (CurrencyHelper#buyer_currency_display_props)

export async function buyerCurrencyDisplayProps(row: LinkRow, seller: UserRow) {
  const productCurrency = link.currency(row);
  const defaults = { product_id: link.externalId(row), buyer_currency_shown: productCurrency, product_currency: productCurrency, buyer_local_price_cents: null, rate: null, display_mode: "default" };
  const disabled = jsonDataForAttr(Users.load(castRow<User>("User", seller as never)), "disable_buyer_local_currency", false);
  const optedIn = !(disabled === true || disabled === "true" || disabled === 1 || disabled === "1") && (await isFeatureEnabled("buyer_local_currency", userActor(seller.id)));
  // Exchange rates, the currency cookie and IP detection decide the rest.
  if (optedIn) throw new NotPortedError("CurrencyHelper#buyer_currency_display_props for a seller using buyer local currency");
  return defaults;
}

// -------------------------------------------------------------------------------------------------
// Card

function truncateDescription(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  // text[0, max - 3].sub(/[[:punct:][:space:]]+\z/, "")
  const kept = chars.slice(0, maxLength - OMISSION.length).join("").replace(TRAILING_PUNCT_OR_SPACE, "");
  return kept + OMISSION;
}

// ProductPresenter.card_for_web
export async function cardForWeb(productId: bigint | number, options: CardOptions = {}): Promise<Record<string, unknown>> {
  const { request = null, showSeller = true, computeDescription = true, computeInventory = true, descriptionMaxLength = DESCRIPTION_MAX_LENGTH } = options;
  const row = await findLink(productId);
  if (!row) throw new Error(`Couldn't find Link with 'id'=${String(productId)}`);
  const seller = (await findUserById(row.user_id!))!;
  const priced = await pricedProduct(row);
  await assertNoDefaultDiscount(row);

  const basePriceCents = displayPriceCents(priced);
  const priceCents = basePriceCents;
  const stat = link.displaysReviews(row) ? await reviewStat(row.id) : null;
  const buyerCurrencyDisplay = request ? await buyerCurrencyDisplayProps(row, seller) : null;
  const defaultRecurrence = priced.prices.find((price) => price.recurrence === (link.subscriptionDuration(row) ?? ""));

  const props: Record<string, unknown> = {
    id: link.externalId(row),
    permalink: row.unique_permalink,
    name: row.name,
    seller: showSeller ? await authorBylineProps(seller, { recommendedBy: options.recommendedBy }) : null,
    ratings: link.displaysReviews(row) ? { count: stat?.reviews_count ?? 0, average: stat?.average_rating ?? 0.0 } : null,
    thumbnail_url: await thumbnailOrCoverUrl(row.id),
    native_type: row.native_type,
    quantity_remaining: computeInventory ? await remainingForSaleCount(row) : null,
    is_sales_limited: computeInventory ? row.max_purchase_count != null : false,
    price_cents: priceCents,
    currency_code: link.currency(row),
    ...(buyerCurrencyDisplay ? { buyer_currency_display: buyerCurrencyDisplay } : {}),
    is_pay_what_you_want: !!row.customizable_price,
    url: await urlForProductPage(row, seller, request, options),
    duration_in_months: row.duration_in_months,
    recurrence: defaultRecurrence?.recurrence ?? null,
  };

  if (computeDescription) props.description = truncateDescription(plaintextDescription(row.description), descriptionMaxLength);
  return props;
}

export { urlForProductPage };
export { hash as jsonDataHash, rubyRound, remainingForSaleCount, displayPriceCents, pricedProduct, assertNoDefaultDiscount, present };
export type { PricedProduct };
