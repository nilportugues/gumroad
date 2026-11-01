// ProductPresenter::ProductProps#props and the pieces of ProductPresenter#product_page_props around it, for the
// products whose whole page this port can prove. Anything it cannot (a Rails-only computation, an uploaded
// file, a code that needs OfferCodeDiscountComputingService) throws NotPortedError, which `assertRenderable`
// turns into a hand back to Rails before anything is sent.
//
// Goldens: spec/requests/product_page_parity_spec.rb, replayed by parity/__tests__/product-page.replay.test.ts.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { LinkFlags } from "../models/link.ts";
import { getFactor } from "../models/purchasing-power-parity.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { isFlagSet, tiktokPixelId, Users } from "../models/user.ts";
import { thumbnailUrl } from "../page-props/buyer/products.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { durationDisplayable, numberToHumanSize, pluralize, resolutionDisplayable } from "./human-size.ts";
import { htmlSafeDescription } from "./description.ts";
import { type LinkRow, type PriceRow, reviewStat, type UserRow } from "./product-reads.ts";
import { authorBylineProps, buyerCurrencyDisplayProps, linkFields, longUrl } from "./product.ts";
import type { User } from "@prisma/client";

const RENTAL_FLAG_POSITION = 1;
const DEFAULT_CURRENCY = "usd";
const LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY = new Date(Date.UTC(2025, 2, 31, 23, 59, 59, 999));
const INSTALLMENT_ELIGIBLE_NATIVE_TYPES = new Set(["call", "course", "digital", "ebook", "bundle"]);
const RECURRENCE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24 };
const ALL_RECURRENCES = Object.keys(RECURRENCE_MONTHS);
const RENEWAL_REMINDER_DAYS: Record<string, number> = { monthly: 1, quarterly: 7, biannually: 7, yearly: 7, every_two_years: 7 };
const LONG_RENEWAL_THRESHOLD_IN_MONTHS = 12;
const LONG_RENEWAL_ADVANCE_REMINDER_DAYS = 30;
const MAX_EPUB_READER_ARCHIVE_SIZE = 32 * 1024 * 1024;
const RATING_COLUMNS = ["ratings_of_one_count", "ratings_of_two_count", "ratings_of_three_count", "ratings_of_four_count", "ratings_of_five_count"];
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
const flag = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) => LinkFlags.isSet(row.flags as bigint | number, name);
const externalId = (id: bigint | number) => encrypt(id);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// Link#json_data, a JSON text column
export function jsonData(row: { json_data?: unknown }): Record<string, unknown> {
  if (typeof row.json_data !== "string" || row.json_data.trim() === "") return {};
  const parsed: unknown = JSON.parse(row.json_data);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
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

const sellerFlagBit = (seller: UserRow, position: number) => ((BigInt(seller.flags ?? 0) >> BigInt(position - 1)) & 1n) === 1n;

// -------------------------------------------------------------------------------------------------
// Reviews (Product::ReviewStat#rating_stats, ProductReviewStat#rating_percentages)

async function ratingStats(productId: bigint) {
  const stat = await reviewStat(productId);
  const counts = RATING_COLUMNS.map((name) => Number(stat?.[name] ?? 0));
  const count = Number(stat?.reviews_count ?? 0);
  return { count, average: Number(stat?.average_rating ?? 0), percentages: ratingPercentages(counts, count) };
}

export function ratingPercentages(counts: number[], reviewsCount: number): number[] {
  if (reviewsCount === 0) return counts;
  const percentages = counts.map((count) => (count / reviewsCount) * 100);
  // Increment the ratings with the largest remainder so the total is 100.
  const remainders = percentages.map((percentage, index) => [percentage % 1, index + 1] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).reverse();
  const threshold = Math.round(remainders.reduce((sum, [remainder]) => sum + remainder, 0));
  for (const [, rating] of remainders.slice(0, threshold)) percentages[rating - 1]! += 1;
  return percentages.map((percentage) => Math.floor(percentage));
}

// -------------------------------------------------------------------------------------------------
// Files (Link#file_info_for_product_page, #has_stream_only_files?, #streamable?)

const isStreamable = (file: Row) => file.filegroup === "video";
const isBrowserReadable = (file: Row) => file.filetype === "pdf" || (file.filetype === "epub" && (file.size === null || Number(file.size) <= MAX_EPUB_READER_ARCHIVE_SIZE));
const PRODUCT_FILE_STREAM_ONLY_FLAG = 4;
const isStreamOnly = (file: Row) => (isStreamable(file) || isBrowserReadable(file)) && ((Number(file.flags) >> (PRODUCT_FILE_STREAM_ONLY_FLAG - 1)) & 1) === 1;

function fileInfo(file: Row, requireShipping: boolean): [string, string][] {
  if (file.filegroup === "image" && requireShipping) return [];
  const entries: [string, string | null][] = [
    ["Size", numberToHumanSize(num(file.size))],
    ["Duration", durationDisplayable(num(file.duration))],
    ["Length", num(file.pagelength) === null ? null : pluralize(num(file.pagelength)!, file.filetype === "epub" ? "section" : "page")],
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
    ...custom.filter((attribute) => present(attribute.name as string) || present(attribute.value as string)).map((attribute) => ({ name: attribute.name, value: attribute.value })),
    ...info.filter(([key]) => !removed.includes(key)).map(([name, value]) => ({ name, value })),
  ];
}

// -------------------------------------------------------------------------------------------------
// Options (Link#options, BaseVariant#to_option, Sku#to_option_for_product)

type VariantRow = Row & { id: bigint; name: string | null; description: string | null; price_difference_cents: number | null; max_purchase_count: number | null; sales_count_for_inventory_cache: number | null; customizable_price: unknown; duration_in_minutes: number | null; flags: number };
const BASE_VARIANT_CLOSED_FLAG = 3;

const quantityLeft = (variant: VariantRow) => (variant.max_purchase_count === null ? null : Math.max(variant.max_purchase_count - (variant.sales_count_for_inventory_cache ?? 0), 0));

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
  const prices = await selectRows<Row>(
    Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} = ${variant.id} AND ${column("prices", "deleted_at")} IS NULL ORDER BY ${column("prices", "id")} ASC`,
  );
  const values: Record<string, { price_cents: number; suggested_price_cents: number | null }> = {};
  for (const recurrence of ALL_RECURRENCES) {
    // link.recurrence_price_enabled?: a buy price of the product itself
    if (!productPrices.some((price) => !isRental(price) && price.recurrence === recurrence)) continue;
    const price = prices.find((candidate) => !isRental(candidate as PriceRow) && candidate.recurrence === recurrence);
    if (price) values[recurrence] = { price_cents: Number(price.price_cents), suggested_price_cents: num(price.suggested_price_cents) };
  }
  return values;
}

const isRental = (price: PriceRow) => (Number(price.flags ?? 0) & RENTAL_FLAG_POSITION) === RENTAL_FLAG_POSITION;

async function optionsProps(row: LinkRow, records: VariantRow[], productPrices: PriceRow[], sellerId: bigint) {
  const skus = flag(row, "skus_enabled");
  const tiered = flag(row, "is_tiered_membership");
  const closeFeature = tiered ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(sellerId)) : false;
  return Promise.all(
    records.map(async (variant) => {
      if (skus) {
        return { id: externalId(variant.id), name: variant.name, quantity_left: quantityLeft(variant), description: variant.description ?? "", price_difference_cents: variant.price_difference_cents, recurrence_price_values: null, is_pwyw: false, duration_in_minutes: variant.duration_in_minutes };
      }
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
    }),
  );
}

// -------------------------------------------------------------------------------------------------
// Prices (Product::Prices)

type Priced = { purchaseType: (typeof PURCHASE_TYPES)[number] | null; prices: PriceRow[] };

const subscriptionDuration = (row: LinkRow) => SUBSCRIPTION_DURATIONS[row.subscription_duration ?? -1] ?? null;
const forCurrency = (row: LinkRow, prices: PriceRow[]) => prices.filter((price) => price.currency === row.price_currency_type);

function rentalPriceCents(row: LinkRow, priced: Priced): number | null {
  if (priced.purchaseType !== "rent_only" && priced.purchaseType !== "buy_and_rent") return null;
  return forCurrency(row, priced.prices).filter(isRental).at(-1)?.price_cents ?? null;
}

function buyPriceCents(row: LinkRow, priced: Priced): number | null {
  if (priced.purchaseType !== "buy_only" && priced.purchaseType !== "buy_and_rent") return null;
  let relevant = forCurrency(row, priced.prices).filter((price) => !isRental(price));
  if (flag(row, "is_recurring_billing") && subscriptionDuration(row) !== null) relevant = relevant.filter((price) => price.recurrence === subscriptionDuration(row));
  return relevant.at(-1)?.price_cents ?? null;
}

// Product::Prices#default_price_cents
const defaultPriceCents = (row: LinkRow, priced: Priced) => (priced.purchaseType === "rent_only" ? rentalPriceCents(row, priced) : buyPriceCents(row, priced));

// -------------------------------------------------------------------------------------------------
// Recurrences (Link#recurrences)

async function recurrencesProps(row: LinkRow, prices: PriceRow[]) {
  if (!flag(row, "is_recurring_billing")) return null;
  const reminders = await isFeatureEnabled("membership_renewal_reminders", userActor(row.user_id!));
  const enabledPrices = prices.filter((price) => !isRental(price) && RECURRENCE_MONTHS[price.recurrence ?? ""] !== undefined).sort((a, b) => RECURRENCE_MONTHS[a.recurrence!]! - RECURRENCE_MONTHS[b.recurrence!]!);
  const leadDays = (recurrence: string) => {
    const advance = RECURRENCE_MONTHS[recurrence]! >= LONG_RENEWAL_THRESHOLD_IN_MONTHS ? LONG_RENEWAL_ADVANCE_REMINDER_DAYS : null;
    return [advance, RENEWAL_REMINDER_DAYS[recurrence]!].filter((days): days is number => days !== null);
  };
  const enabled = enabledPrices.map((price) => ({ recurrence: price.recurrence, price_cents: price.price_cents, id: externalId(price.id), renewal_reminder_days: reminders ? leadDays(price.recurrence!) : [] }));
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
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\n+/).map((paragraph) => paragraph.replace(/([^\n]\n)(?=[^\n])/g, "$1<br />"));
  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("\n\n") || "<p></p>";
}

async function refundPolicyProps(row: LinkRow, seller: UserRow) {
  const policyProps = (policy: Row & { max_refund_period_in_days: number | null; fine_print: string | null; updated_at: Date }) => ({
    title: REFUND_PERIOD_TITLES[policy.max_refund_period_in_days ?? -1] ?? null,
    fine_print: present(policy.fine_print) ? simpleFormat(policy.fine_print) : null,
    updated_at: isoDate(policy.updated_at),
  });
  let accountLevel = sellerFlagBit(seller, USER_REFUND_POLICY_ENABLED_FLAG);
  if (accountLevel) {
    if (await isFeatureEnabled("seller_refund_policy_disabled_for_all")) accountLevel = false;
    else if ((await isFeatureEnabled("account_level_refund_policy_delayed_for_sellers", userActor(seller.id))) && new Date() <= LAST_ALLOWED_TIME_FOR_PRODUCT_LEVEL_REFUND_POLICY) accountLevel = false;
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
  return (BLOCKED_SUBDIVISIONS[country.toUpperCase()] ?? []).includes(location.regionName.toUpperCase().replace(`${country.toUpperCase()}-`, ""));
}

async function pppDetails(row: LinkRow, seller: UserRow, ip: string | null) {
  const geo = ip ? geoIpLookup(ip) : null;
  const enabled = !flag(row, "purchasing_power_parity_disabled") && sellerFlagBitByName(seller, "purchasing_power_parity_enabled");
  if (!enabled || !geo) return null;
  const factor = await getFactor(geo.countryCode, seller as unknown as { purchasing_power_parity_limit: number | null });
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
  const closed = (variant: VariantRow) => flag(row, "is_tiered_membership") && closeFeature && ((Number(variant.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1;
  const available = (variant: VariantRow) => !closed(variant) && (variant.max_purchase_count === null || quantityLeft(variant)! > 0);
  const categoryAvailable = (category: { id: bigint }) => {
    const own = alive.filter((variant) => variant.variant_category_id === category.id);
    return own.length === 0 || own.some(available);
  };
  if (categories.length > 0 && !categories.some(categoryAvailable)) return 0;
  const tiers = variants.filter((variant) => categories.some((category) => category.id === variant.variant_category_id && (category.title ?? "").toLowerCase() === "tier"));
  if (tiers.length === 1) return quantityLeft(tiers[0]!);
  if (flag(row, "is_bundle")) throw new NotPortedError("Link#remaining_for_sale_count for a bundle");
  if (row.max_purchase_count === null) return null;
  return Math.max(row.max_purchase_count - (row.sales_count_for_inventory_cache ?? 0), 0);
}

async function hasRows(tableName: string, where: Prisma.Sql): Promise<boolean> {
  return (await selectRows(Prisma.sql`SELECT 1 FROM ${table(tableName)} WHERE ${where} LIMIT 1`)).length > 0;
}

// Link#collaborator_for_display: any collaboration on the product goes to Rails.
async function assertNoCollaborator(row: LinkRow): Promise<void> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("affiliates_links")} INNER JOIN ${table("affiliates")} ON ${column("affiliates", "id")} = ${column("affiliates_links", "affiliate_id")} WHERE ${column("affiliates_links", "link_id")} = ${row.id} AND ${column("affiliates", "type")} = 'Collaborator' AND ${column("affiliates", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (rows.length > 0) throw new NotPortedError("Link#collaborator_for_display");
}

// BestOfferCodeService#default_offer_codes is empty: no default offer code and no shop-wide sale.
async function assertNoDefaultOfferCodes(row: LinkRow): Promise<void> {
  if (row.default_offer_code_id !== null) throw new NotPortedError("BestOfferCodeService with a default offer code");
  if (await hasRows("offer_codes", Prisma.sql`${column("offer_codes", "user_id")} = ${row.user_id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "universal")} = TRUE AND ${column("offer_codes", "auto_apply")} = TRUE`)) {
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
function pwywDefaultPriceCents(row: LinkRow, options: { price_difference_cents: number | null }[], rental: { price_cents: number } | null, priceCents: number): number | null {
  if (flag(row, "is_tiered_membership") || flag(row, "is_recurring_billing")) return null;
  if (priceCents !== 0 || (row.suggested_price_cents ?? 0) !== 0) return null;
  if (rental !== null && rental.price_cents !== 0) return null;
  return options.every((option) => (option.price_difference_cents ?? 0) === 0) ? 0 : null;
}

// Product::StructuredData#minimum_offer_price_cents: the lowest price a buyer could pay, null without a price.
export async function minimumOfferPriceCents(row: LinkRow): Promise<number | null> {
  const prices = await alivePricesOf(row.id);
  const priced: Priced = { purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null, prices };
  if (flag(row, "is_tiered_membership")) {
    const closeFeature = await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!));
    const tiers = await selectRows<VariantRow>(
      Prisma.sql`SELECT ${star("base_variants")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${row.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("variant_categories", "title")} = 'Tier' AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "id")} ASC`,
    );
    const open = tiers.filter((tier) => !(closeFeature && ((Number(tier.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1));
    const offered = open.length > 0 ? open : tiers;
    if (offered.length === 0) return 0;
    const variantPrices = await selectRows<Row>(
      Prisma.sql`SELECT ${star("prices")} FROM ${table("prices")} WHERE ${column("prices", "variant_id")} IN (${Prisma.join(offered.map((tier) => tier.id))}) AND ${column("prices", "deleted_at")} IS NULL`,
    );
    const buy = variantPrices.filter((price) => !isRental(price as PriceRow));
    return buy.length === 0 ? 0 : Math.min(...buy.map((price) => Number(price.price_cents)));
  }
  const candidates: (number | null)[] = [buyPriceCents(row, priced)];
  if (priced.purchaseType === "rent_only" || priced.purchaseType === "buy_and_rent") candidates.push(rentalPriceCents(row, priced));
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
  const differences = options.map((option) => option.price_difference_cents).filter((cents): cents is number => cents !== null);
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
  const available = (tier: VariantRow) => !(closeFeature && ((Number(tier.flags) >> (BASE_VARIANT_CLOSED_FLAG - 1)) & 1) === 1) && (tier.max_purchase_count === null || quantityLeft(tier)! > 0);
  return tiers.length > 0 && !tiers.some(available);
}

export const remainingForSaleCount = async (row: LinkRow) =>
  remainingForSale(row, flag(row, "is_tiered_membership") ? await isFeatureEnabled("close_membership_tier_to_new_buyers", userActor(row.user_id!)) : false);

export type ProductPageViewerInput = {
  user: User | null;
  remoteIp: string | null;
  browserGuid: string | null;
  quantity: number;
  discountCode: string | null;
  purchaseId: string | null;
  purchaseEmailDigest: string | null;
  recommendedBy: string | null;
  sellerCustomDomainUrl: string | null;
};

// -------------------------------------------------------------------------------------------------
// The props

export async function productProps(row: LinkRow, seller: UserRow, viewer: ProductPageViewerInput) {
  const sellerActor = userActor(seller.id);
  if (await isFeatureEnabled("seller_reputation_summary", sellerActor)) throw new NotPortedError("User#seller_reputation_summary");
  if (viewer.user) throw new NotPortedError("ProductPresenter::ProductProps for a signed-in visitor");
  if (viewer.discountCode !== null) throw new NotPortedError("BestOfferCodeService for a code in the URL");
  if (viewer.purchaseId !== null || viewer.purchaseEmailDigest !== null) throw new NotPortedError("Link#purchase_for_email_digest");
  if (viewer.browserGuid !== null && (await hasRows("purchases", Prisma.sql`${column("purchases", "link_id")} = ${row.id} AND ${column("purchases", "browser_guid")} = ${viewer.browserGuid}`))) {
    throw new NotPortedError("Link#purchase_info_for_product_page");
  }
  await assertNoDefaultOfferCodes(row);
  await assertNoCollaborator(row);
  if (flag(row, "should_show_sales_count")) throw new NotPortedError("ProductPresenter.cached_sales_count");
  if (flag(row, "is_bundle")) throw new NotPortedError("ProductProps#bundle_product_props");
  const published = row.deleted_at === null && row.purchase_disabled_at === null && !row.draft;
  if (flag(row, "waitlist_enabled") && !published && row.deleted_at === null && row.banned_at === null && !flag(row, "is_unpublished_by_admin")) throw new NotPortedError("ProductProps#waitlist_props");
  if (await hasRows("public_files", Prisma.sql`${column("public_files", "resource_type")} = 'Link' AND ${column("public_files", "resource_id")} = ${row.id} AND ${column("public_files", "deleted_at")} IS NULL`)) throw new NotPortedError("PublicFilePresenter#props");
  if (await hasRows("asset_previews", Prisma.sql`${column("asset_previews", "link_id")} = ${row.id} AND ${column("asset_previews", "deleted_at")} IS NULL`)) throw new NotPortedError("AssetPreview#as_json");

  const [files, prices] = await Promise.all([aliveProductFiles(row.id), alivePricesOf(row.id)]);
  const priced: Priced = { purchaseType: PURCHASE_TYPES[row.purchase_type ?? -1] ?? null, prices };
  const records = await optionRecords(row);
  const tiered = flag(row, "is_tiered_membership");
  const recurring = flag(row, "is_recurring_billing");
  const priceCents = defaultPriceCents(row, priced);
  if (priceCents === null) throw new NotPortedError("ProductProps with a product that has no price");
  const rentalPrice = rentalPriceCents(row, priced);
  const rental = rentalPrice !== null ? { price_cents: rentalPrice, rent_only: priced.purchaseType === "rent_only" } : null;
  const options = await optionsProps(row, records, prices, seller.id);
  const closeFeature = tiered ? await isFeatureEnabled("close_membership_tier_to_new_buyers", sellerActor) : false;
  const plan = await installmentPlan(row.id);
  const recurrences = await recurrencesProps(row, prices);
  const data = jsonData(row);

  const product = {
    id: linkFields.externalId(row),
    permalink: row.unique_permalink,
    name: row.name,
    seller: await authorBylineProps(seller, { recommendedBy: viewer.recommendedBy, customDomainUrl: viewer.sellerCustomDomainUrl }),
    collaborating_user: null,
    covers: [],
    main_cover_id: null,
    thumbnail_url: await thumbnailUrl(row.id),
    quantity_remaining: await remainingForSale(row, closeFeature),
    long_url: longUrl(row, seller),
    is_sales_limited: (row.max_purchase_count ?? 0) !== 0,
    ratings: flag(row, "display_product_reviews") ? await ratingStats(row.id) : null,
    custom_button_text_option: (data.custom_button_text_option as string | null | undefined) ?? null,
    is_compliance_blocked: complianceBlocked(viewer.remoteIp),
    is_published: !row.draft && row.deleted_at === null,
    is_stream_only: files.some(isStreamOnly),
    streamable: files.some(isStreamable),
    sales_count: null,
    summary: present(data.custom_summary as string) ? data.custom_summary : null,
    attributes: attributesProps(row, files),
    description_html: htmlSafeDescription(row.description),
    currency_code: (present(row.price_currency_type) ? row.price_currency_type : DEFAULT_CURRENCY).toLowerCase(),
    price_cents: priceCents,
    buyer_currency_display: await buyerCurrencyDisplayProps(row, seller),
    rental_price_cents: rentalPrice,
    pwyw: row.customizable_price ? { suggested_price_cents: row.suggested_price_cents, default_price_cents: pwywDefaultPriceCents(row, options, rental, priceCents) } : null,
    eligible_for_installment_plans: !recurring && !tiered && !flag(row, "is_in_preorder_state") && INSTALLMENT_ELIGIBLE_NATIVE_TYPES.has(row.native_type ?? ""),
    allow_installment_plan: plan !== null,
    installment_plan: plan ? { number_of_installments: plan.number_of_installments, recurrence: plan.recurrence } : null,
    is_legacy_subscription: !tiered && recurring,
    is_tiered_membership: tiered,
    is_recurring_billing: recurring,
    is_physical: flag(row, "is_physical"),
    custom_view_content_button_text: present(data.custom_view_content_button_text as string) ? data.custom_view_content_button_text : null,
    is_multiseat_license: flag(row, "is_multiseat_license") && row.native_type !== "call",
    is_licensed: flag(row, "is_licensed"),
    hide_sold_out_variants: flag(row, "hide_sold_out_variants"),
    native_type: row.native_type,
    preorder: flag(row, "is_in_preorder_state") ? { release_date: await preorderRelease(row.id) } : null,
    duration_in_months: row.duration_in_months,
    rental,
    is_quantity_enabled: flag(row, "quantity_enabled"),
    free_trial: flag(row, "free_trial_enabled") ? { duration: { unit: TRIAL_UNITS[row.free_trial_duration_unit ?? -1] ?? null, amount: row.free_trial_duration_amount } } : null,
    recurrences,
    options,
    analytics: analyticsData(seller),
    has_third_party_analytics: await hasThirdPartyAnalytics(row, seller, "product"),
    ppp_details: await pppDetails(row, seller, viewer.remoteIp),
    can_edit: false,
    waitlist: null,
    refund_policy: await refundPolicyProps(row, seller),
    bundle_products: [],
    public_files: [],
  };
  return {
    product,
    discount_code: null,
    sale_label: null,
    selection_discounts: { url_code: null, quantity: viewer.quantity, recurrence: recurrences?.default ?? null, option_id: null, price_cents: null, options: {}, rent_options: null },
    purchase: null,
    wishlists: [],
  };
}

