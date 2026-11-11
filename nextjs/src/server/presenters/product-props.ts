// ProductPresenter::ProductProps#props and the pieces of ProductPresenter#product_page_props around it, for the
// products whose whole page this port can prove. Anything it cannot (a Rails-only computation, an uploaded
// file, a code that needs OfferCodeDiscountComputingService) throws NotPortedError, which `assertRenderable`
// turns into a hand back to Rails before anything is sent.
//
// Goldens: spec/requests/product_page_parity_spec.rb, replayed by parity/__tests__/product-page.replay.test.ts.
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { LinkFlags } from "../models/link.ts";
import { getFactor } from "../models/purchasing-power-parity.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isFlagSet, tiktokPixelId, Users } from "../models/user.ts";
import { thumbnailUrl } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { collaboratingProductIds, linkPolicy } from "../policies/link.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { sellerReputationProps } from "../models/user-reputation-summary.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { bestOfferCodeResult, defaultOfferCodes, saleLabel } from "./best-offer-code.ts";
import { htmlSafeDescription } from "./description.ts";
import { durationDisplayable, numberToHumanSize, pluralize, resolutionDisplayable } from "./human-size.ts";
import {
  assertNoAttachedPublicFiles,
  assertNoBoughtPurchase,
  coverProps,
  waitlistProps,
  wishlistProps,
} from "./product-props-extras.ts";
import { findLink, findUserById, type LinkRow, type PriceRow, reviewStat, type UserRow } from "./product-reads.ts";
import {
  authorBylineProps,
  buyerCurrencyDisplayProps,
  linkFields,
  longUrl,
  type PresenterRequest,
  urlForProductPage,
} from "./product.ts";

const RENTAL_FLAG_POSITION = 1;
const DEFAULT_CURRENCY = "usd";
const LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY = new Date(Date.UTC(2025, 2, 31, 23, 59, 59, 999));
const INSTALLMENT_ELIGIBLE_NATIVE_TYPES = new Set(["call", "course", "digital", "ebook", "bundle"]);
const RECURRENCE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  biannually: 6,
  yearly: 12,
  every_two_years: 24,
};
const ALL_RECURRENCES = Object.keys(RECURRENCE_MONTHS);
const RENEWAL_REMINDER_DAYS: Record<string, number> = {
  monthly: 1,
  quarterly: 7,
  biannually: 7,
  yearly: 7,
  every_two_years: 7,
};
const LONG_RENEWAL_THRESHOLD_IN_MONTHS = 12;
const LONG_RENEWAL_ADVANCE_REMINDER_DAYS = 30;
const MAX_EPUB_READER_ARCHIVE_SIZE = 32 * 1024 * 1024;
const RATING_COLUMNS = [
  "ratings_of_one_count",
  "ratings_of_two_count",
  "ratings_of_three_count",
  "ratings_of_four_count",
  "ratings_of_five_count",
];
const PURCHASE_TYPES = ["buy_only", "rent_only", "buy_and_rent"] as const;
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"] as const;
const TRIAL_UNITS = ["week", "month"] as const;
const FREE_TRIAL_EXPIRING_REMINDER_DAYS = 2;
const REFUND_PERIOD_TITLES: Record<number, string> = {
  0: "No refunds allowed",
  7: "7-day money back guarantee",
  14: "14-day money back guarantee",
  30: "30-day money back guarantee",
  183: "6-month money back guarantee",
};
const USER_REFUND_POLICY_ENABLED_FLAG = 46;

type Row = Record<string, unknown>;
const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const flag = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) =>
  LinkFlags.isSet(row.flags as bigint | number, name);
const externalId = (id: bigint | number) => encrypt(id);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// Link#json_data, a JSON text column
export function jsonData(row: { json_data?: unknown }): Record<string, unknown> {
  if (typeof row.json_data !== "string" || row.json_data.trim() === "") return {};
  const parsed: unknown = JSON.parse(row.json_data);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export type ProductPageViewer = {
  user: User | null;
  remoteIp: string | null;
  browserGuid: string | null;
  quantity: number;
  discountCode: string | null;
  layout: string | null;
  purchaseId: string | null;
  purchaseEmailDigest: string | null;
};

const star = (name: string) => Prisma.raw(`\`${name}\`.*`);

// -------------------------------------------------------------------------------------------------
// Reads

const aliveProductFiles = (productId: bigint) =>
  selectRows<Row>(
    Prisma.sql`SELECT ${star("product_files")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${productId} AND ${column("product_files", "deleted_at")} IS NULL ORDER BY ${column("product_files", "position")} ASC`,
  );

const alivePricesOf = (productId: bigint) =>
  selectRows<PriceRow & Row>(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "link_id")} = ${productId} AND ${column("prices", "deleted_at")} IS NULL ORDER BY ${column("prices", "id")} ASC`,
  );

const sellerFlagBit = (seller: UserRow, position: number) =>
  ((BigInt(seller.flags ?? 0) >> BigInt(position - 1)) & 1n) === 1n;

// -------------------------------------------------------------------------------------------------
// Reviews (Product::ReviewStat#rating_stats, ProductReviewStat#rating_percentages)

export async function ratingStats(productId: bigint) {
  const stat = await reviewStat(productId);
  const counts = RATING_COLUMNS.map((name) => Number(stat?.[name] ?? 0));
  const count = Number(stat?.reviews_count ?? 0);
  return { count, average: Number(stat?.average_rating ?? 0), percentages: ratingPercentages(counts, count) };
}

export function ratingPercentages(counts: number[], reviewsCount: number): number[] {
  if (reviewsCount === 0) return counts;
  const percentages = counts.map((count) => (count / reviewsCount) * 100);
  // Increment the ratings with the largest remainder so the total is 100.
  const remainders = percentages
    .map((percentage, index) => [percentage % 1, index + 1] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .reverse();
  const threshold = Math.round(remainders.reduce((sum, [remainder]) => sum + remainder, 0));
  for (const [, rating] of remainders.slice(0, threshold)) percentages[rating - 1]! += 1;
  return percentages.map((percentage) => Math.floor(percentage));
}

// ProductPresenter.cached_sales_count -> Product::Stats#successful_sales_count. Rails caches it for a minute; the port
// reads the current count.
const ACTIVE_SALES_SEARCH_OPTIONS = {
  state: ["preorder_authorization_successful", "successful", "not_charged"],
  exclude_refunded_except_subscriptions: true,
  exclude_unreversed_chargedback: true,
  exclude_non_original_subscription_purchases: true,
  exclude_deactivated_subscriptions: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};

export async function successfulSalesCount(productId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process({
    ...ACTIVE_SALES_SEARCH_OPTIONS,
    product: Number(productId),
    size: 0,
    track_total_hits: true,
  });
  return result.total ?? 0;
}

// -------------------------------------------------------------------------------------------------
// Files (Link#file_info_for_product_page, #has_stream_only_files?, #streamable?)

const isStreamable = (file: Row) => file.filegroup === "video";
const isBrowserReadable = (file: Row) =>
  file.filetype === "pdf" ||
  (file.filetype === "epub" && (file.size === null || Number(file.size) <= MAX_EPUB_READER_ARCHIVE_SIZE));
const PRODUCT_FILE_STREAM_ONLY_FLAG = 4;
const isStreamOnly = (file: Row) =>
  (isStreamable(file) || isBrowserReadable(file)) &&
  ((Number(file.flags) >> (PRODUCT_FILE_STREAM_ONLY_FLAG - 1)) & 1) === 1;

function fileInfo(file: Row, requireShipping: boolean): [string, string][] {
  if (file.filegroup === "image" && requireShipping) return [];
  const entries: [string, string | null][] = [
    ["Size", numberToHumanSize(num(file.size))],
    ["Duration", durationDisplayable(num(file.duration))],
    [
      "Length",
      num(file.pagelength) === null
        ? null
        : pluralize(num(file.pagelength)!, file.filetype === "epub" ? "section" : "page"),
    ],
    ["Resolution", resolutionDisplayable(num(file.width), num(file.height))],
  ];
  return entries.filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "");
}

function attributesProps(row: LinkRow, files: Row[]) {
  const data = jsonData(row);
  const custom = (Array.isArray(data.custom_attributes) ? data.custom_attributes : []) as Row[];
  const removed = ((data.removed_file_info_attributes as string[] | undefined) ?? []).map(String);
  const info = !flag(row, "is_bundle") && files.length === 1 ? fileInfo(files[0]!, !!row.require_shipping) : [];
  return [
    ...custom
      .filter((attribute) => present(attribute.name as string) || present(attribute.value as string))
      .map((attribute) => ({ name: attribute.name, value: attribute.value })),
    ...info.filter(([key]) => !removed.includes(key)).map(([name, value]) => ({ name, value })),
  ];
}

// -------------------------------------------------------------------------------------------------
// Options (Link#options, BaseVariant#to_option, Sku#to_option_for_product)

type VariantRow = Row & {
  id: bigint;
  name: string | null;
  description: string | null;
  price_difference_cents: number | null;
  max_purchase_count: number | null;
  sales_count_for_inventory_cache: number | null;
  customizable_price: unknown;
  duration_in_minutes: number | null;
  flags: number;
};
const BASE_VARIANT_CLOSED_FLAG = 3;

const quantityLeft = (variant: VariantRow) =>
  variant.max_purchase_count === null
    ? null
    : Math.max(variant.max_purchase_count - (variant.sales_count_for_inventory_cache ?? 0), 0);

async function optionRecords(row: LinkRow): Promise<VariantRow[]> {
  if (flag(row, "skus_enabled")) {
    return selectRows<VariantRow>(
      Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Sku' AND ${column("base_variants", "link_id")} = ${row.id} AND ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "flags")} & 1) = 0 ORDER BY ${column("base_variants", "id")} ASC`,
    );
  }
  const [category] = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC LIMIT 1`,
  );
  if (!category) return [];
  return selectRows<VariantRow>(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "variant_category_id")} = ${category.id} AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "position_in_category")} ASC, ${column("base_variants", "created_at")} ASC`,
  );
}

// Variant#recurrence_price_values (not for the editor)
async function recurrencePriceValues(variant: VariantRow, productPrices: PriceRow[]) {
  // A deleted tier offers no price (`alive? && link.recurrence_price_enabled?`); only a subscription's own attrs would revive one.
  if (variant.deleted_at != null) return {};
  const prices = await selectRows<Row>(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${variant.id} AND ${column("prices", "deleted_at")} IS NULL ORDER BY ${column("prices", "id")} ASC`,
  );
  const values: Record<string, { price_cents: number; suggested_price_cents: number | null }> = {};
  for (const recurrence of ALL_RECURRENCES) {
    // link.recurrence_price_enabled?: a buy price of the product itself
    if (!productPrices.some((price) => !isRental(price) && price.recurrence === recurrence)) continue;
    const price = prices.find((candidate) => !isRental(candidate as PriceRow) && candidate.recurrence === recurrence);
    if (price)
      values[recurrence] = {
        price_cents: Number(price.price_cents),
        suggested_price_cents: num(price.suggested_price_cents),
      };
  }
  return values;
}

const isRental = (price: PriceRow) => (Number(price.flags ?? 0) & RENTAL_FLAG_POSITION) === RENTAL_FLAG_POSITION;

// BaseVariant#to_option of a Variant, for a buyer who is not subscribed (`subscribed: false`).
export async function variantToOption(row: LinkRow, variant: VariantRow, productPrices: PriceRow[], sellerId: bigint) {
  const tiered = flag(row, "is_tiered_membership");
  const closeFeature = tiered
    ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(sellerId))
    : false;
  return variantOptionProps(row, variant, productPrices, tiered, closeFeature);
}

async function variantOptionProps(
  row: LinkRow,
  variant: VariantRow,
  productPrices: PriceRow[],
  tiered: boolean,
  closeFeature: boolean,
) {
  const closed = closeFeature && ((Number(variant.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1;
  return {
    id: externalId(variant.id),
    name: variant.name === "Untitled" ? row.name : (variant.name ?? ""),
    quantity_left: closed ? 0 : quantityLeft(variant),
    description: variant.description ?? "",
    price_difference_cents: variant.price_difference_cents,
    recurrence_price_values: tiered ? await recurrencePriceValues(variant, productPrices) : null,
    is_pwyw: !!variant.customizable_price,
    duration_in_minutes: variant.duration_in_minutes,
  };
}

async function optionsProps(row: LinkRow, records: VariantRow[], productPrices: PriceRow[], sellerId: bigint) {
  const skus = flag(row, "skus_enabled");
  const tiered = flag(row, "is_tiered_membership");
  const closeFeature = tiered
    ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(sellerId))
    : false;
  return Promise.all(
    records.map(async (variant) => {
      if (skus) {
        return {
          id: externalId(variant.id),
          name: variant.name,
          quantity_left: quantityLeft(variant),
          description: variant.description ?? "",
          price_difference_cents: variant.price_difference_cents,
          recurrence_price_values: null,
          is_pwyw: false,
          duration_in_minutes: variant.duration_in_minutes,
        };
      }
      return variantOptionProps(row, variant, productPrices, tiered, closeFeature);
    }),
  );
}

// Link#options
export async function linkOptions(row: LinkRow) {
  if (row.user_id === null) throw new NotPortedError("Link#options of a product without a seller");
  const [records, prices] = await Promise.all([optionRecords(row), alivePricesOf(row.id)]);
  return optionsProps(row, records, prices, row.user_id);
}

// -------------------------------------------------------------------------------------------------
// Prices (Product::Prices)

type Priced = { purchaseType: (typeof PURCHASE_TYPES)[number] | null; prices: PriceRow[] };

const subscriptionDuration = (row: LinkRow) => SUBSCRIPTION_DURATIONS[row.subscription_duration ?? -1] ?? null;
const forCurrency = (row: LinkRow, prices: PriceRow[]) =>
  prices.filter((price) => price.currency === row.price_currency_type);

function rentalPriceCents(row: LinkRow, priced: Priced): number | null {
  if (priced.purchaseType !== "rent_only" && priced.purchaseType !== "buy_and_rent") return null;
  return forCurrency(row, priced.prices).filter(isRental).at(-1)?.price_cents ?? null;
}

function buyPriceCents(row: LinkRow, priced: Priced): number | null {
  if (priced.purchaseType !== "buy_only" && priced.purchaseType !== "buy_and_rent") return null;
  let relevant = forCurrency(row, priced.prices).filter((price) => !isRental(price));
  if (flag(row, "is_recurring_billing") && subscriptionDuration(row) !== null)
    relevant = relevant.filter((price) => price.recurrence === subscriptionDuration(row));
  return relevant.at(-1)?.price_cents ?? null;
}

// Product::Prices#default_price_cents
const defaultPriceCents = (row: LinkRow, priced: Priced) =>
  priced.purchaseType === "rent_only" ? rentalPriceCents(row, priced) : buyPriceCents(row, priced);

// Product::Prices#price_cents, which is nil for a product without a price.
export async function listedPriceCents(row: LinkRow): Promise<number | null> {
  const priced: Priced = {
    purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null,
    prices: await alivePricesOf(row.id),
  };
  return defaultPriceCents(row, priced);
}

// -------------------------------------------------------------------------------------------------
// Recurrences (Link#recurrences)

async function recurrencesProps(row: LinkRow, prices: PriceRow[]) {
  if (!flag(row, "is_recurring_billing")) return null;
  const reminders = await isFeatureEnabled("membership_renewal_reminders", userActor(row.user_id!));
  const enabledPrices = prices
    .filter((price) => !isRental(price) && RECURRENCE_MONTHS[price.recurrence ?? ""] !== undefined)
    .sort((a, b) => RECURRENCE_MONTHS[a.recurrence!]! - RECURRENCE_MONTHS[b.recurrence!]!);
  const leadDays = (recurrence: string) => {
    const advance =
      RECURRENCE_MONTHS[recurrence]! >= LONG_RENEWAL_THRESHOLD_IN_MONTHS ? LONG_RENEWAL_ADVANCE_REMINDER_DAYS : null;
    return [advance, RENEWAL_REMINDER_DAYS[recurrence]!].filter((days): days is number => days !== null);
  };
  const enabled = enabledPrices.map((price) => ({
    recurrence: price.recurrence,
    price_cents: price.price_cents,
    id: externalId(price.id),
    renewal_reminder_days: reminders ? leadDays(price.recurrence!) : [],
  }));
  const defaultPrice = prices.find((price) => price.recurrence === (subscriptionDuration(row) ?? ""));
  const defaultRecurrence = defaultPrice?.recurrence ?? enabled[0]?.recurrence ?? null;
  if (defaultRecurrence === null) return null;
  const trialDays = reminders && flag(row, "free_trial_enabled") ? FREE_TRIAL_EXPIRING_REMINDER_DAYS : null;
  return { default: defaultRecurrence, enabled, free_trial_reminder_days: trialDays };
}

// -------------------------------------------------------------------------------------------------
// Refund policy (ProductPresenter::ProductProps#refund_policy_props)

// ActionController::Base.helpers.simple_format for text with no markup to sanitize.
function simpleFormat(text: string): string {
  if (/[<>&]/.test(text)) throw new NotPortedError("simple_format over a refund policy's fine print with markup");
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\n+/)
    .map((paragraph) => paragraph.replace(/([^\n]\n)(?=[^\n])/g, "$1<br />"));
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n\n") || "<p></p>";
}

async function refundPolicyProps(row: LinkRow, seller: UserRow) {
  const policyProps = (
    policy: Row & { max_refund_period_in_days: number | null; fine_print: string | null; updated_at: Date },
  ) => ({
    title: REFUND_PERIOD_TITLES[policy.max_refund_period_in_days ?? -1] ?? null,
    fine_print: present(policy.fine_print) ? simpleFormat(policy.fine_print) : null,
    updated_at: isoDate(policy.updated_at),
  });
  let accountLevel = sellerFlagBit(seller, USER_REFUND_POLICY_ENABLED_FLAG);
  if (accountLevel) {
    if (await isFeatureEnabled("seller_refund_policy_disabled_for_all")) accountLevel = false;
    else if (
      (await isFeatureEnabled("account_level_refund_policy_delayed_for_sellers", userActor(seller.id))) &&
      new Date() <= LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY
    )
      accountLevel = false;
  }
  if (accountLevel) {
    const [policy] = await selectRows<any>(
      Prisma.sql`SELECT ${star("refund_policies")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "seller_id")} = ${seller.id} AND ${column("refund_policies", "product_id")} IS NULL LIMIT 1`,
    );
    // The policy is a required association of an account with the setting on.
    if (!policy) throw new NotPortedError("User#refund_policy for an account without one");
    return policyProps(policy);
  }
  if (flag(row, "product_refund_policy_enabled")) {
    const [policy] = await selectRows<any>(
      Prisma.sql`SELECT ${star("refund_policies")} FROM ${table("refund_policies")} WHERE ${column("refund_policies", "product_id")} = ${row.id} LIMIT 1`,
    );
    if (policy) return policyProps(policy);
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// PPP and compliance (Link#ppp_details, #compliance_blocked)

const BLOCKED_COUNTRIES = new Set(["CU", "IR", "KP"]);
const BLOCKED_SUBDIVISIONS: Record<string, string[]> = { UA: ["43", "40", "14", "09"], RU: ["CR", "SEV"] };

function complianceBlocked(ip: string | null): boolean {
  if (!ip) return false;
  const location = geoIpLookup(ip);
  if (!location) return false;
  const country = location.countryCode;
  if (country !== null && BLOCKED_COUNTRIES.has(country)) return true;
  if (!country || !location.regionName) return false;
  return (BLOCKED_SUBDIVISIONS[country.toUpperCase()] ?? []).includes(
    location.regionName.toUpperCase().replace(`${country.toUpperCase()}-`, ""),
  );
}

async function pppDetails(row: LinkRow, seller: UserRow, ip: string | null) {
  const geo = ip ? geoIpLookup(ip) : null;
  const enabled =
    !flag(row, "purchasing_power_parity_disabled") && sellerFlagBitByName(seller, "purchasing_power_parity_enabled");
  if (!enabled || !geo) return null;
  const factor = await getFactor(
    geo.countryCode,
    seller as unknown as { purchasing_power_parity_limit: number | null },
  );
  if (factor >= 1) return null;
  throw new NotPortedError("Link#ppp_details with a country factor below 1");
}

function sellerFlagBitByName(seller: UserRow, name: string): boolean {
  return isFlagSet(Users.load(seller as unknown as User), name as never);
}

// -------------------------------------------------------------------------------------------------
// Analytics (User#analytics_data, Link#has_third_party_analytics?)

function analyticsData(seller: UserRow) {
  const record = Users.load(seller as unknown as User);
  return {
    google_analytics_id: seller.google_analytics_id ?? null,
    facebook_pixel_id: seller.facebook_pixel_id ?? null,
    tiktok_pixel_id: tiktokPixelId(record),
    free_sales: !isFlagSet(record, "skip_free_sale_analytics"),
  };
}

async function hasThirdPartyAnalytics(row: LinkRow, seller: UserRow, location: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("third_party_analytics")} WHERE ${column("third_party_analytics", "deleted_at")} IS NULL AND ${column("third_party_analytics", "location")} IN (${location}, 'all') AND (${column("third_party_analytics", "link_id")} = ${row.id} OR (${column("third_party_analytics", "user_id")} = ${seller.id} AND ${column("third_party_analytics", "link_id")} IS NULL)) LIMIT 1`,
  );
  return rows.length > 0;
}

// -------------------------------------------------------------------------------------------------
// Inventory (Link#remaining_for_sale_count, Link#variants_available?)

async function remainingForSale(row: LinkRow, closeFeature: boolean): Promise<number | null> {
  const categories = await selectRows<{ id: bigint; title: string | null }>(
    Prisma.sql`SELECT ${column("variant_categories", "id")}, ${column("variant_categories", "title")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC`,
  );
  const variants =
    categories.length === 0
      ? []
      : await selectRows<VariantRow & { variant_category_id: bigint }>(
          Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "variant_category_id")} IN (${Prisma.join(categories.map((category) => category.id))}) ORDER BY ${column("base_variants", "id")} ASC`,
        );
  const alive = variants.filter((variant) => variant.deleted_at === null);
  const closed = (variant: VariantRow) =>
    flag(row, "is_tiered_membership") &&
    closeFeature &&
    ((Number(variant.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1;
  const available = (variant: VariantRow) =>
    !closed(variant) && (variant.max_purchase_count === null || quantityLeft(variant)! > 0);
  const categoryAvailable = (category: { id: bigint }) => {
    const own = alive.filter((variant) => variant.variant_category_id === category.id);
    return own.length === 0 || own.some(available);
  };
  if (categories.length > 0 && !categories.some(categoryAvailable)) return 0;
  const tiers = variants.filter((variant) =>
    categories.some(
      (category) => category.id === variant.variant_category_id && (category.title ?? "").toLowerCase() === "tier",
    ),
  );
  if (tiers.length === 1) return quantityLeft(tiers[0]!);
  let bundleLeft: number | null = null;
  if (flag(row, "is_bundle")) {
    const lefts: number[] = [];
    for (const { product, variant } of await aliveBundleProducts(row.id)) {
      const productLeft = await remainingForSale(product, closeFeature);
      if (productLeft !== null) lefts.push(productLeft);
      if (variant) {
        const variantLeft = quantityLeft(variant);
        if (variantLeft !== null) lefts.push(variantLeft);
      }
    }
    bundleLeft = lefts.length === 0 ? null : Math.min(...lefts);
  }
  const productLeft =
    row.max_purchase_count === null ? null : row.max_purchase_count - (row.sales_count_for_inventory_cache ?? 0);
  const left = [productLeft, bundleLeft].filter((count): count is number => count !== null);
  return left.length === 0 ? null : Math.max(Math.min(...left), 0);
}

type BundleProduct = { row: Row; quantity: number; product: LinkRow; variant: VariantRow | null };

// Link#bundle_products.in_order.alive, each with its product and option
async function aliveBundleProducts(bundleId: bigint): Promise<BundleProduct[]> {
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${star("bundle_products")} FROM ${table("bundle_products")} WHERE ${column("bundle_products", "bundle_id")} = ${bundleId} AND ${column("bundle_products", "deleted_at")} IS NULL ORDER BY ${column("bundle_products", "position")} ASC, ${column("bundle_products", "id")} ASC`,
  );
  const result: BundleProduct[] = [];
  for (const row of rows) {
    const product = await findLink(row.product_id as bigint);
    if (!product) throw new NotPortedError("BundleProduct without a product");
    const [variant] =
      row.variant_id == null
        ? []
        : await selectRows<VariantRow>(
            Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${row.variant_id as bigint} LIMIT 1`,
          );
    result.push({ row, quantity: Number(row.quantity), product, variant: variant ?? null });
  }
  return result;
}

// ProductProps#bundle_product_props
async function bundleProductsProps(bundle: LinkRow, viewer: ProductPageViewerInput) {
  const props = [];
  for (const { quantity, product, variant } of await aliveBundleProducts(bundle.id)) {
    const priced: Priced = {
      purchaseType: PURCHASE_TYPES[product.purchase_type ?? -1] ?? null,
      prices: await alivePricesOf(product.id),
    };
    const memberPrice = defaultPriceCents(product, priced);
    if (memberPrice === null) throw new NotPortedError("BundleProduct#standalone_price_cents without a price");
    const seller = await findUserById(product.user_id!);
    props.push({
      id: linkFields.externalId(product),
      name: product.name,
      ratings:
        !flag(bundle, "hide_bundle_product_reviews") && flag(product, "display_product_reviews")
          ? await reviewSummary(product)
          : null,
      price: (memberPrice + (variant?.price_difference_cents ?? 0)) * quantity,
      currency_code: (present(product.price_currency_type)
        ? product.price_currency_type
        : DEFAULT_CURRENCY
      ).toLowerCase(),
      thumbnail_url: await thumbnailUrl(product.id),
      native_type: product.native_type,
      url: await urlForProductPage(product, seller!, viewer.request, { recommendedBy: viewer.recommendedBy }),
      quantity,
      variant: variant?.name ?? null,
    });
  }
  return props;
}

async function hasRows(tableName: string, where: Prisma.Sql): Promise<boolean> {
  return (await selectRows(Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${where} LIMIT 1`)).length > 0;
}

const AFFILIATE_APPLY_TO_ALL_PRODUCTS = 1n << 0n;
const AFFILIATE_DONT_SHOW_AS_CO_CREATOR = 1n << 2n;
const PRODUCT_AFFILIATE_DONT_SHOW_AS_CO_CREATOR = 1n << 0n;

// Link#collaborator_for_display: the accepted, undeleted collaborator's user, unless the collaboration hides the
// co-creator credit. A pending invitation (a collaborator_invitations row) does not count.
export async function collaboratorForDisplay(row: LinkRow): Promise<UserRow | null> {
  const [collaboration] = await selectRows<{
    affiliate_user_id: bigint | number | null;
    affiliate_flags: bigint | number | null;
    product_affiliate_flags: bigint | number | null;
  }>(
    Prisma.sql`SELECT ${column("affiliates", "affiliate_user_id")}, ${column("affiliates", "flags")} AS affiliate_flags, ${column("affiliates_links", "flags")} AS product_affiliate_flags FROM ${table("affiliates_links")} INNER JOIN ${table("affiliates")} ON ${column("affiliates", "id")} = ${column("affiliates_links", "affiliate_id")} LEFT OUTER JOIN ${table("collaborator_invitations")} ON ${column("collaborator_invitations", "collaborator_id")} = ${column("affiliates", "id")} WHERE ${column("affiliates_links", "link_id")} = ${row.id} AND ${column("affiliates", "type")} = 'Collaborator' AND ${column("affiliates", "deleted_at")} IS NULL AND ${column("collaborator_invitations", "id")} IS NULL LIMIT 1`,
  );
  if (!collaboration || collaboration.affiliate_user_id === null) return null;
  // Collaborator#show_as_co_creator_for_product?
  const shown =
    (BigInt(collaboration.affiliate_flags ?? 0) & AFFILIATE_APPLY_TO_ALL_PRODUCTS) !== 0n
      ? (BigInt(collaboration.affiliate_flags ?? 0) & AFFILIATE_DONT_SHOW_AS_CO_CREATOR) === 0n
      : (BigInt(collaboration.product_affiliate_flags ?? 0) & PRODUCT_AFFILIATE_DONT_SHOW_AS_CO_CREATOR) === 0n;
  return shown ? findUserById(collaboration.affiliate_user_id) : null;
}

// BestOfferCodeService#default_offer_codes is empty: no default offer code and no shop-wide sale.
async function assertNoDefaultOfferCodes(row: LinkRow): Promise<void> {
  if (row.default_offer_code_id !== null) throw new NotPortedError("BestOfferCodeService with a default offer code");
  if (
    await hasRows(
      "offer_codes",
      Prisma.sql`${column("offer_codes", "user_id")} = ${row.user_id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = TRUE AND ${column("offer_codes", "auto_apply")} = TRUE`,
    )
  ) {
    throw new NotPortedError("User#auto_apply_offer_code_for");
  }
}

async function preorderRelease(productId: bigint): Promise<string | null> {
  const [link] = await selectRows<{ release_at: Date | null }>(
    Prisma.sql`SELECT ${column("preorder_links", "release_at")} FROM ${table("preorder_links")} WHERE ${column("preorder_links", "link_id")} = ${productId} ORDER BY ${column("preorder_links", "id")} ASC LIMIT 1`,
  );
  return link?.release_at ? link.release_at.toISOString() : null;
}

async function installmentPlan(productId: bigint) {
  const [plan] = await selectRows<{ number_of_installments: number; recurrence: string }>(
    Prisma.sql`SELECT ${column("product_installment_plans", "number_of_installments")}, ${column("product_installment_plans", "recurrence")} FROM ${table("product_installment_plans")} WHERE ${column("product_installment_plans", "link_id")} = ${productId} AND ${column("product_installment_plans", "deleted_at")} IS NULL ORDER BY ${column("product_installment_plans", "id")} ASC LIMIT 1`,
  );
  return plan ?? null;
}

// ProductProps#pwyw_default_price_cents
function pwywDefaultPriceCents(
  row: LinkRow,
  options: { price_difference_cents: number | null }[],
  rental: { price_cents: number } | null,
  priceCents: number,
): number | null {
  if (flag(row, "is_tiered_membership") || flag(row, "is_recurring_billing")) return null;
  if (priceCents !== 0 || (row.suggested_price_cents ?? 0) !== 0) return null;
  if (rental !== null && rental.price_cents !== 0) return null;
  return options.every((option) => (option.price_difference_cents ?? 0) === 0) ? 0 : null;
}

// Product::Prices#lowest_tier_price(for_default_duration:).price_cents: the cheapest buy price of the tiers a new
// buyer can pick (every alive tier when all are closed), 0 without one.
export async function lowestTierPriceCents(row: LinkRow, forDefaultDuration: boolean): Promise<number> {
  const closeFeature = await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!));
  const tiers = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = 'Tier' AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "id")} ASC`,
  );
  const open = tiers.filter(
    (tier) => !(closeFeature && ((Number(tier.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1),
  );
  const offered = open.length > 0 ? open : tiers;
  if (offered.length === 0) return 0;
  const variantPrices = await selectRows<Row>(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} IN (${Prisma.join(offered.map((tier) => tier.id))}) AND ${column("prices", "deleted_at")} IS NULL`,
  );
  const duration = SUBSCRIPTION_DURATIONS[row.subscription_duration ?? -1] ?? null;
  const buy = variantPrices.filter(
    (price) => !isRental(price as PriceRow) && (!forDefaultDuration || price.recurrence === duration),
  );
  return buy.length === 0 ? 0 : Math.min(...buy.map((price) => Number(price.price_cents)));
}

// Product::StructuredData#minimum_offer_price_cents: the lowest price a buyer could pay, null without a price.
export async function minimumOfferPriceCents(row: LinkRow): Promise<number | null> {
  const prices = await alivePricesOf(row.id);
  const priced: Priced = { purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null, prices };
  if (flag(row, "is_tiered_membership")) return lowestTierPriceCents(row, false);
  const candidates: (number | null)[] = [buyPriceCents(row, priced)];
  if (priced.purchaseType === "rent_only" || priced.purchaseType === "buy_and_rent")
    candidates.push(rentalPriceCents(row, priced));
  if (flag(row, "is_recurring_billing")) {
    const buyPrices = prices.filter((price) => !isRental(price));
    if (buyPrices.length > 0) candidates.push(Math.min(...buyPrices.map((price) => price.price_cents!)));
  }
  const base = candidates.filter((cents): cents is number => cents !== null);
  if (base.length === 0) return null;
  const lowest = Math.min(...base);
  const options = await selectRows<{ price_difference_cents: number | null }>(
    Prisma.sql`SELECT ${column("base_variants", "price_difference_cents")} FROM ${table("base_variants")} WHERE ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "link_id")} = ${row.id} OR ${column("base_variants", "variant_category_id")} IN (SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL))`,
  );
  const differences = options
    .map((option) => option.price_difference_cents)
    .filter((cents): cents is number => cents !== null);
  return lowest + (differences.length === 0 ? 0 : Math.min(...differences));
}

export async function reviewSummary(row: LinkRow) {
  const stat = await reviewStat(row.id);
  return { count: Number(stat?.reviews_count ?? 0), average: Number(stat?.average_rating ?? 0) };
}

export async function closedMembershipForNewBuyers(row: LinkRow): Promise<boolean> {
  if (!flag(row, "is_tiered_membership")) return false;
  const closeFeature = await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!));
  const tiers = await selectRows<VariantRow>(
    Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = 'Tier' AND ${column("base_variants", "deleted_at")} IS NULL`,
  );
  const available = (tier: VariantRow) =>
    !(closeFeature && ((Number(tier.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1) &&
    (tier.max_purchase_count === null || quantityLeft(tier)! > 0);
  return tiers.length > 0 && !tiers.some(available);
}

export const remainingForSaleCount = async (row: LinkRow) =>
  remainingForSale(
    row,
    flag(row, "is_tiered_membership")
      ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!))
      : false,
  );

export type ProductPageViewerInput = {
  user: User | null;
  context: SellerContext | null;
  remoteIp: string | null;
  browserGuid: string | null;
  quantity: number;
  discountCode: string | null;
  purchaseId: string | null;
  purchaseEmailDigest: string | null;
  recommendedBy: string | null;
  sellerCustomDomainUrl: string | null;
  request: PresenterRequest;
  // Side effects of a rendered page (the reputation snapshot's refresh job), run by whoever sends the page.
  afterRender?: (() => Promise<void>)[];
};

// -------------------------------------------------------------------------------------------------
// The props

// The options ProductProps#selection_discounts quotes, as the keys of its hash ("" for a product with no options): a tier closed to
// new buyers cannot be picked and is left out. `rental` is Link#rental's rent_only, or null when the product cannot be rented.
export async function selectionOptions(row: LinkRow) {
  const [records, prices] = await Promise.all([optionRecords(row), alivePricesOf(row.id)]);
  const priced: Priced = { purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null, prices };
  const closeFeature = flag(row, "is_tiered_membership")
    ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!))
    : false;
  const open = records.filter(
    (record) => !closeFeature || ((Number(record.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 0,
  );
  return {
    optionIds: records.length === 0 ? [""] : open.map((record) => externalId(record.id)),
    rental: rentalPriceCents(row, priced) !== null ? { rent_only: priced.purchaseType === "rent_only" } : null,
  };
}

export async function productProps(row: LinkRow, seller: UserRow, viewer: ProductPageViewerInput) {
  const sellerActor = userActor(seller.id);
  const reputation = await sellerReputationProps(seller, row, viewer.afterRender);
  let canEdit = false;
  let wishlists: Awaited<ReturnType<typeof wishlistProps>> = [];
  if (viewer.user && viewer.context) {
    canEdit = linkPolicy.edit(
      viewer.context,
      { id: row.id, user_id: row.user_id, flags: row.flags as bigint | number },
      await collaboratingProductIds(viewer.context, [row.id]),
    );
    if (viewer.context.seller) wishlists = await wishlistProps(row, viewer.context.seller.id);
  }
  if (viewer.purchaseId !== null || viewer.purchaseEmailDigest !== null)
    throw new NotPortedError("Link#purchase_for_email_digest");
  await assertNoBoughtPurchase(
    row,
    { userId: viewer.user && viewer.context ? viewer.user.id : null, browserGuid: viewer.browserGuid },
    flag(row, "is_in_preorder_state"),
  );
  const collaborator = await collaboratorForDisplay(row);
  const published = row.deleted_at === null && row.purchase_disabled_at === null && !row.draft;
  const waitlist =
    flag(row, "waitlist_enabled") &&
    !published &&
    row.deleted_at === null &&
    row.banned_at === null &&
    !flag(row, "is_unpublished_by_admin")
      ? await waitlistProps(row, seller, canEdit)
      : null;
  await assertNoAttachedPublicFiles(row);
  const covers = await coverProps(row);

  const [files, prices] = await Promise.all([aliveProductFiles(row.id), alivePricesOf(row.id)]);
  const priced: Priced = { purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null, prices };
  const records = await optionRecords(row);
  const tiered = flag(row, "is_tiered_membership");
  const recurring = flag(row, "is_recurring_billing");
  const priceCents = defaultPriceCents(row, priced);
  if (priceCents === null) throw new NotPortedError("ProductProps with a product that has no price");
  const rentalPrice = rentalPriceCents(row, priced);
  const rental =
    rentalPrice !== null ? { price_cents: rentalPrice, rent_only: priced.purchaseType === "rent_only" } : null;
  const options = await optionsProps(row, records, prices, seller.id);
  const closeFeature = tiered ? await isFeatureEnabled("close_membership_tier_to_new_buyers", sellerActor) : false;
  const plan = await installmentPlan(row.id);
  const recurrences = await recurrencesProps(row, prices);
  const data = jsonData(row);
  const closedIds = new Set(
    closeFeature
      ? records
          .filter((record) => ((Number(record.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1)
          .map((record) => record.id)
      : [],
  );

  const product = {
    id: linkFields.externalId(row),
    permalink: row.unique_permalink,
    name: row.name,
    seller: await authorBylineProps(seller, {
      recommendedBy: viewer.recommendedBy,
      customDomainUrl: viewer.sellerCustomDomainUrl,
    }),
    collaborating_user: collaborator ? await authorBylineProps(collaborator) : null,
    ...covers,
    thumbnail_url: await thumbnailUrl(row.id),
    quantity_remaining: await remainingForSale(row, closeFeature),
    long_url: longUrl(row, seller),
    is_sales_limited: (row.max_purchase_count ?? 0) !== 0,
    ratings: flag(row, "display_product_reviews") ? await ratingStats(row.id) : null,
    ...reputation,
    custom_button_text_option: (data.custom_button_text_option as string | null | undefined) ?? null,
    is_compliance_blocked: complianceBlocked(viewer.remoteIp),
    is_published: !row.draft && row.deleted_at === null,
    is_stream_only: files.some(isStreamOnly),
    streamable: files.some(isStreamable),
    sales_count: flag(row, "should_show_sales_count") ? await successfulSalesCount(row.id) : null,
    summary: present(data.custom_summary as string) ? data.custom_summary : null,
    attributes: attributesProps(row, files),
    description_html: htmlSafeDescription(row.description),
    currency_code: (present(row.price_currency_type) ? row.price_currency_type : DEFAULT_CURRENCY).toLowerCase(),
    price_cents: priceCents,
    buyer_currency_display: await buyerCurrencyDisplayProps(row, seller),
    rental_price_cents: rentalPrice,
    pwyw: row.customizable_price
      ? {
          suggested_price_cents: row.suggested_price_cents,
          default_price_cents: pwywDefaultPriceCents(row, options, rental, priceCents),
        }
      : null,
    eligible_for_installment_plans:
      !recurring &&
      !tiered &&
      !flag(row, "is_in_preorder_state") &&
      INSTALLMENT_ELIGIBLE_NATIVE_TYPES.has(row.native_type ?? ""),
    allow_installment_plan: plan !== null,
    installment_plan: plan
      ? { number_of_installments: plan.number_of_installments, recurrence: plan.recurrence }
      : null,
    is_legacy_subscription: !tiered && recurring,
    is_tiered_membership: tiered,
    is_recurring_billing: recurring,
    is_physical: flag(row, "is_physical"),
    custom_view_content_button_text: present(data.custom_view_content_button_text as string)
      ? data.custom_view_content_button_text
      : null,
    is_multiseat_license: flag(row, "is_multiseat_license") && row.native_type !== "call",
    is_licensed: flag(row, "is_licensed"),
    hide_sold_out_variants: flag(row, "hide_sold_out_variants"),
    native_type: row.native_type,
    preorder: flag(row, "is_in_preorder_state") ? { release_date: await preorderRelease(row.id) } : null,
    duration_in_months: row.duration_in_months,
    rental,
    is_quantity_enabled: flag(row, "quantity_enabled"),
    free_trial: flag(row, "free_trial_enabled")
      ? {
          duration: {
            unit: TRIAL_UNITS[row.free_trial_duration_unit ?? -1] ?? null,
            amount: row.free_trial_duration_amount,
          },
        }
      : null,
    recurrences,
    options,
    analytics: analyticsData(seller),
    has_third_party_analytics: await hasThirdPartyAnalytics(row, seller, "product"),
    ppp_details: await pppDetails(row, seller, viewer.remoteIp),
    can_edit: canEdit,
    waitlist,
    refund_policy: await refundPolicyProps(row, seller),
    bundle_products: await bundleProductsProps(row, viewer),
    public_files: [],
  };
  const defaults = await defaultOfferCodes(row);
  const result = await bestOfferCodeResult(row, defaults, viewer.discountCode, viewer.quantity);
  const urlCode = present(viewer.discountCode) ? viewer.discountCode : null;
  const selectionQuantity = Math.max(viewer.quantity, 1);
  const inputs = {
    url_code: urlCode,
    quantity: selectionQuantity,
    recurrence: recurrences?.default ?? null,
    option_id: null,
    price_cents: null,
  };
  let selection: Record<string, unknown> = { ...inputs, options: {}, rent_options: null };
  if (urlCode !== null || defaults.codes.length > 0) {
    // The same code answers every option it covers (a code limited to options is handed back), so it is
    // quoted once; a tier closed to new buyers cannot be picked and is left out.
    const quote = await bestOfferCodeResult(row, defaults, urlCode, selectionQuantity);
    const entry = { discount_code: quote, sale_label: saleLabel(quote, defaults.auto) };
    const quotes = () =>
      Object.fromEntries(
        (records.length === 0 ? [null] : records)
          .filter((record) => record === null || !closedIds.has(record.id))
          .map((record) => [record === null ? "" : externalId(record.id), entry]),
      );
    selection = { ...inputs, options: quotes(), rent_options: rental && !rental.rent_only ? quotes() : null };
    if (rental?.rent_only) selection.options = quotes();
  }
  return {
    product,
    discount_code: result,
    sale_label: saleLabel(result, defaults.auto),
    selection_discounts: selection,
    purchase: null,
    wishlists,
  };
}
