// The product listings the seller dashboard shares (DashboardProductsPagePresenter, CollabProductsPagePresenter):
// sorting and pagination (ProductsHelper#sort_and_paginate_products), a row's price and status, thumbnails and
// the cached stats. What the port cannot answer exactly goes to Rails whole (HandBackToRails), decided before the
// page renders: a currency other than USD, rentals, an uploaded thumbnail, a sort that Elasticsearch performs,
// a closed membership tier, and a product without a fresh ProductCachedValue (Rails enqueues a job for it).
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { LinkFlags } from "../../models/link.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { formatMoney } from "../audience/filters.ts";
import { paramToI, type QuerySource } from "../audience/support.ts";
import { productLongUrl } from "../buyer/users.ts";
import { domainConfig } from "../domain.ts";

export const PER_PAGE = 50;
export const PRODUCT_SORT_KEYS = ["name", "display_price_cents", "successful_sales_count", "revenue", "status"] as const;
const SQL_SORT_KEYS = new Set(["name", "successful_sales_count", "revenue", "status", "cut"]);

export type Sort = { key: string; direction: "asc" | "desc" };
export type TableParams = { page: string | null; sort: Sort | null };
export type ListingParams = { query: string | null; products: TableParams; memberships: TableParams };

// `params.permit(...)` reads a scalar; the last value of a repeated key wins (Rack).
function scalar(source: QuerySource, name: string): string | null {
  let value: string | null = null;
  for (const pair of source.queryString.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = decode(index === -1 ? pair : pair.slice(0, index));
    if (key === name) value = index === -1 ? "" : decode(pair.slice(index + 1));
  }
  return value;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

// `extract_sort_params`
function sortParam(source: QuerySource, prefix: "products" | "memberships", keys: readonly string[]): Sort | null {
  const key = scalar(source, `${prefix}_sort_key`);
  if (key === null || !keys.includes(key)) return null;
  return { key, direction: scalar(source, `${prefix}_sort_direction`) === "desc" ? "desc" : "asc" };
}

export function listingParams(source: QuerySource, sortKeys: readonly string[] = PRODUCT_SORT_KEYS): ListingParams {
  return {
    query: scalar(source, "query"),
    products: { page: scalar(source, "products_page"), sort: sortParam(source, "products", sortKeys) },
    memberships: { page: scalar(source, "memberships_page"), sort: sortParam(source, "memberships", sortKeys) },
  };
}

// A page that Pagy would not read like String#to_i, and a sort the port does not run, go to Rails.
export function assertTableSupported(table: TableParams): void {
  if (table.page !== null && !/^-?\d+$/u.test(table.page)) throw new HandBackToRails();
  if (table.sort && !SQL_SORT_KEYS.has(table.sort.key)) throw new HandBackToRails();
}

export type LinkRow = Prisma.LinkGetPayload<object>;

// The Link columns a listing row reads.
const LISTING_COLUMNS = [
  "id", "user_id", "name", "unique_permalink", "custom_permalink", "flags", "purchase_disabled_at", "deleted_at", "draft", "price_currency_type",
  "purchase_type", "subscription_duration", "duration_in_months", "customizable_price", "price_cents", "rental_price_cents", "created_at",
] as const;
const listingColumns = () => Prisma.join(LISTING_COLUMNS.map((name) => column("links", name)));

export type Page = { pages: number; page: number };

// `pagy(collection.sorted_by(...).order(created_at: :desc), limit: PER_PAGE, page:, overflow: :last_page)`
// over `from` (tables and joins) and `where`.
export async function sortAndPaginate(options: { from: Prisma.Sql; where: Prisma.Sql; table: TableParams; sellerId: bigint; cut?: Prisma.Sql }): Promise<{ pagination: Page; rows: LinkRow[] }> {
  const { from, where, table: params, sellerId } = options;
  const direction = Prisma.raw(params.sort?.direction === "desc" ? "DESC" : "ASC");
  let joins = Prisma.empty;
  let order = Prisma.empty;
  switch (params.sort?.key) {
    case "name":
      order = Prisma.sql`${column("links", "name")} ${direction}, `;
      break;
    case "status":
      order = Prisma.sql`links.purchase_disabled_at IS NULL ${direction}, `;
      break;
    case "successful_sales_count":
    case "revenue":
      joins = latestCachedValuesJoin(sellerId);
      order = Prisma.sql`${Prisma.raw(`\`latest_product_cached_values\`.\`${params.sort.key === "revenue" ? "total_usd_cents" : "successful_sales_count"}\``)} ${direction}, `;
      break;
    case "cut":
      order = options.cut ? Prisma.sql`${options.cut} ${direction}, ` : Prisma.empty;
      break;
  }
  const withCte = joins === Prisma.empty ? Prisma.empty : cachedValuesCte(sellerId);

  const [counted] = await selectRows<{ count: bigint }>(Prisma.sql`${withCte}SELECT COUNT(*) AS count FROM ${from}${joins} WHERE ${where}`);
  const count = Number(counted?.count ?? 0);
  const last = Math.max(Math.ceil(count / PER_PAGE), 1);
  const requested = params.page === null ? 1 : paramToI(params.page);
  const page = Math.min(requested <= 0 ? 1 : requested, last);
  const rows = await selectRows(
    Prisma.sql`${withCte}SELECT ${listingColumns()} FROM ${from}${joins} WHERE ${where} ORDER BY ${order}${column("links", "created_at")} DESC LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`,
  );
  return { pagination: { pages: last, page }, rows: rows.map((row) => castRow<LinkRow>("Link", row)) };
}

// Link.with_latest_product_cached_values
function cachedValuesCte(sellerId: bigint): Prisma.Sql {
  return Prisma.sql`WITH \`latest_product_cached_values\` AS (SELECT \`product_cached_values\`.* FROM \`product_cached_values\` INNER JOIN (SELECT product_id, MAX(id) AS max_id FROM product_cached_values WHERE product_id IN (SELECT \`links\`.\`id\` FROM \`links\` WHERE \`links\`.\`user_id\` = ${sellerId}) GROUP BY product_id) latest ON product_cached_values.product_id = latest.product_id AND product_cached_values.id = latest.max_id) `;
}
const latestCachedValuesJoin = (_sellerId: bigint): Prisma.Sql => Prisma.sql` LEFT JOIN latest_product_cached_values ON latest_product_cached_values.product_id = links.id`;

// ---- rows ----

const USD = "usd";
const BUY_ONLY = 0;
const RECURRENCES = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"] as const;
// BasePrice::Recurrence#recurrence_long_indicator
export const RECURRENCE_LABELS: Record<string, string> = {
  monthly: "a month",
  quarterly: "every 3 months",
  biannually: "every 6 months",
  yearly: "a year",
  every_two_years: "every 2 years",
};
const IS_RENTAL_FLAG = 1;
const CLOSED_TO_NEW_PURCHASES_FLAG = 4;

type PriceRow = { id: number; link_id: number | null; variant_id: number | null; price_cents: number; recurrence: string | null; flags: number };
type VariantRow = { id: number; variant_category_id: number | null; link_id: number | null; price_difference_cents: number | null; flags: number; customizable_price: boolean | number | null; type: string | null };

export type RowData = {
  prices: PriceRow[];
  variants: VariantRow[];
  // variant_categories.id -> its product and whether it is the "Tier" category
  categories: Map<number, { link_id: number; tier: boolean }>;
  thumbnails: Map<bigint, { id: bigint; unsplash_url: string | null; guid: string | null; deleted_at: Date | null }>;
};

const ids = (rows: readonly LinkRow[]) => rows.map((row) => row.id);

// The rows the price and thumbnail of each product are computed from.
export async function loadRowData(rows: readonly LinkRow[]): Promise<RowData> {
  if (rows.length === 0) return { prices: [], variants: [], categories: new Map(), thumbnails: new Map() };
  const productIds = Prisma.join(ids(rows));
  const categories = await selectRows<{ id: number; link_id: number; title: string | null }>(
    Prisma.sql`SELECT id, link_id, title FROM variant_categories WHERE deleted_at IS NULL AND link_id IN (${productIds})`,
  );
  const categoryIds = categories.map((category) => category.id);
  const variants = await selectRows<VariantRow>(
    Prisma.sql`SELECT id, variant_category_id, link_id, price_difference_cents, flags, customizable_price, type FROM base_variants
      WHERE deleted_at IS NULL AND (link_id IN (${productIds})${categoryIds.length > 0 ? Prisma.sql` OR variant_category_id IN (${Prisma.join(categoryIds)})` : Prisma.empty}) ORDER BY id ASC`,
  );
  const variantIds = variants.map((variant) => variant.id);
  const prices = await selectRows<PriceRow>(
    Prisma.sql`SELECT id, link_id, variant_id, price_cents, recurrence, flags FROM prices
      WHERE deleted_at IS NULL AND (link_id IN (${productIds})${variantIds.length > 0 ? Prisma.sql` OR variant_id IN (${Prisma.join(variantIds)})` : Prisma.empty}) ORDER BY id ASC`,
  );
  const thumbnailRows = await selectRows<{ id: bigint; product_id: bigint; unsplash_url: string | null; guid: string | null; deleted_at: Date | null }>(
    Prisma.sql`SELECT id, product_id, unsplash_url, guid, deleted_at FROM thumbnails WHERE product_id IN (${productIds}) ORDER BY id ASC`,
  );
  const thumbnails: RowData["thumbnails"] = new Map();
  for (const thumbnail of thumbnailRows) if (!thumbnails.has(BigInt(thumbnail.product_id))) thumbnails.set(BigInt(thumbnail.product_id), { ...thumbnail, id: BigInt(thumbnail.id) });
  return { prices, variants, categories: new Map(categories.map((category) => [category.id, { link_id: category.link_id, tier: category.title?.toLowerCase() === "tier" }])), thumbnails };
}

const isSet = (flags: bigint | number, flag: "is_recurring_billing" | "is_tiered_membership" | "is_in_preorder_state" | "is_duplicating" | "archived") => LinkFlags.isSet(flags, flag);

// Thumbnails that go through Active Storage (an uploaded file) are not ported.
export async function assertThumbnailsSupported(data: RowData): Promise<void> {
  const unsplashFree = [...data.thumbnails.values()].filter((thumbnail) => !thumbnail.unsplash_url);
  if (unsplashFree.length === 0) return;
  const attached = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_type")} = 'Thumbnail' AND ${column("active_storage_attachments", "record_id")} IN (${Prisma.join(unsplashFree.map((t) => t.id))}) LIMIT 1`,
  );
  if (attached.length > 0) throw new HandBackToRails();
}

// `product.thumbnail&.alive&.as_json`
export function thumbnailJson(product: LinkRow, data: RowData): { url: string | null; guid: string | null } | null {
  const thumbnail = data.thumbnails.get(product.id);
  if (!thumbnail || thumbnail.deleted_at !== null) return null;
  return { url: thumbnail.unsplash_url && thumbnail.unsplash_url.trim() !== "" ? thumbnail.unsplash_url : null, guid: thumbnail.guid };
}

const dollars = (cents: number) => {
  const formatted = `$${formatMoney(cents, USD)}`;
  // Product::Prices#format_price
  return formatted === "$0.99" ? "99¢" : formatted;
};

type Tier = { variant: VariantRow; prices: PriceRow[] };

// Product::Prices tiers_for_displayed_price: the alive tiers a new buyer can purchase (a fully closed membership
// shows its price anyway). A closed tier depends on `can_close_to_new_buyers?`, which the port leaves to Rails.
function tiersOf(product: LinkRow, data: RowData): Tier[] {
  const tiers = data.variants.filter((variant) => {
    const category = variant.variant_category_id === null ? undefined : data.categories.get(variant.variant_category_id);
    return variant.type === "Variant" && category?.tier === true && category.link_id === Number(product.id);
  });
  return tiers.map((variant) => ({ variant, prices: data.prices.filter((price) => price.variant_id === variant.id) }));
}

const buyPrices = (prices: PriceRow[]) => prices.filter((price) => (price.flags & IS_RENTAL_FLAG) === 0);

// What a row's price needs and the port cannot do goes to Rails.
export function assertPriceSupported(product: LinkRow, data: RowData): void {
  if ((product.price_currency_type ?? USD).toLowerCase() !== USD) throw new HandBackToRails();
  if (product.purchase_type !== BUY_ONLY && product.purchase_type !== null) throw new HandBackToRails();
  if (product.duration_in_months !== null && isSet(product.flags, "is_tiered_membership")) throw new HandBackToRails();
  if (isSet(product.flags, "is_tiered_membership") && tiersOf(product, data).some((tier) => (tier.variant.flags & CLOSED_TO_NEW_PURCHASES_FLAG) !== 0)) throw new HandBackToRails();
}

const subscriptionDuration = (product: LinkRow) => (product.subscription_duration === null ? null : (RECURRENCES[product.subscription_duration] ?? null));

// Link#display_price_cents
export function displayPriceCents(product: LinkRow, data: RowData): number {
  if (isSet(product.flags, "is_tiered_membership")) return lowestTierPrice(product, data).price_cents;
  const alivePrices = data.prices.filter((price) => price.link_id === Number(product.id) && price.variant_id === null);
  let relevant = buyPrices(alivePrices);
  if (isSet(product.flags, "is_recurring_billing") && subscriptionDuration(product) !== null) relevant = relevant.filter((price) => price.recurrence === subscriptionDuration(product));
  const base = relevant.at(-1)?.price_cents ?? 0;
  const options = data.variants.filter(
    (variant) => variant.link_id === Number(product.id) || (variant.variant_category_id !== null && data.categories.get(variant.variant_category_id)?.link_id === Number(product.id)),
  );
  const differences = options.map((variant) => variant.price_difference_cents).filter((value): value is number => value !== null);
  return base + (differences.length > 0 ? Math.min(...differences) : 0);
}

function lowestTierPrice(product: LinkRow, data: RowData): { price_cents: number; recurrence: string | null } {
  const candidates = tiersOf(product, data).flatMap((tier) => buyPrices(tier.prices));
  const lowest = candidates.reduce<PriceRow | null>((best, price) => (best === null || price.price_cents < best.price_cents ? price : best), null);
  return lowest ?? { price_cents: 0, recurrence: subscriptionDuration(product) };
}

// Link#price_formatted_including_rental_verbose for a buy-only product
export function priceFormattedVerbose(product: LinkRow, data: RowData): string {
  const tiered = isSet(product.flags, "is_tiered_membership");
  const recurrence = tiered ? lowestTierPrice(product, data).recurrence : subscriptionDuration(product);
  let customizable: boolean;
  if (!tiered) customizable = !!product.customizable_price;
  else {
    const offered = tiersOf(product, data);
    customizable = offered.length > 1 || offered.some((tier) => !!tier.variant.customizable_price) || (offered.length === 1 && buyPrices(offered[0]!.prices).length > 1);
  }
  const label = isSet(product.flags, "is_recurring_billing") ? ` ${recurrence ? (RECURRENCE_LABELS[recurrence] ?? "") : ""}` : "";
  return `${dollars(displayPriceCents(product, data))}${customizable ? "+" : ""}${label}`;
}

// ---- stats ----

export type CachedStats = { successful_sales_count: number | null; remaining_for_sale_count: number | null; monthly_recurring_revenue: number; revenue_pending: number; total_usd_cents: number };

// Product::Caching.dashboard_collection_data: the fresh cached value of each product; a product without one is
// computed from Elasticsearch and enqueues a CacheProductDataWorker job, which Rails does.
export async function freshCachedStats(rows: readonly LinkRow[]): Promise<Map<bigint, CachedStats>> {
  const values = await db.productCachedValue.findMany({ where: { product_id: { in: ids(rows) }, expired: false }, orderBy: { id: "asc" } });
  const stats = new Map<bigint, CachedStats>();
  for (const value of values) {
    if (stats.has(value.product_id)) continue;
    stats.set(value.product_id, {
      successful_sales_count: value.successful_sales_count,
      remaining_for_sale_count: value.remaining_for_sale_count,
      monthly_recurring_revenue: value.monthly_recurring_revenue?.toNumber() ?? 0,
      revenue_pending: value.revenue_pending?.toNumber() ?? 0,
      total_usd_cents: Number(value.total_usd_cents ?? 0),
    });
  }
  return stats;
}

export function assertStatsCached(rows: readonly LinkRow[], stats: Map<bigint, CachedStats>): void {
  if (rows.some((row) => !stats.has(row.id))) throw new HandBackToRails();
}

export const externalEditPath = (product: LinkRow) => `/products/${product.unique_permalink}/edit`;
// Integer#present?
export const hasDuration = (product: LinkRow) => product.duration_in_months !== null;

export function productUrls(product: LinkRow, owner: Parameters<typeof productLongUrl>[1]): { url: string; url_without_protocol: string } {
  const url = productLongUrl(product as never, owner);
  return { url, url_without_protocol: url.slice(`${domainConfig(process.env).protocol}://`.length) };
}

export { isSet as productFlag };
