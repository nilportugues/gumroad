// The curated products of DiscoverCuratedProducts#curated_products: RecommendedProducts::DiscoverService seeded with the
// alive products of the visitor's cart and the products they purchased.
//
// Only the deterministic seeds are answered. From 4 associated ids `fetch_recommended_products` samples half of them at
// random: that is answered only when none of the ids has a cached related-products row (every sample is then empty), otherwise,
// like a non-default `recommended_products_associated_product_ids_limit` (it makes the order of the seeds matter), it is a
// NotPortedError (the controller hands the request back to Rails).
import { Prisma } from "@prisma/client";

import { getRedis } from "../../infra/redis.ts";
import { isAdult } from "../../models/concerns/adult-keyword-detector.ts";
import { column, columnIn, selectRows, table } from "../../models/sql.ts";
import { bit, findLink, findUserById, type LinkRow } from "../../presenters/product-reads.ts";
import { effectiveUsername } from "../../presenters/product.ts";
import { NotPortedError } from "../not-ported.ts";

export type CuratedVisitor = { id: bigint } | null;

// RecommendedProducts::BaseService::NUMBER_OF_RESULTS
const NUMBER_OF_RESULTS = 40;
const SAMPLED_FROM_ASSOCIATED_IDS = 4;
// `associated_product_ids_limit` when the Redis key is unset
const DEFAULT_ASSOCIATED_LIMIT = 100;
const ASSOCIATED_LIMIT_KEY = "recommended_products_associated_product_ids_limit";
const ARCHIVED_FLAG = 5;
const IS_ADULT_FLAG = 16;
const ALL_ADULT_PRODUCTS_FLAG = 32;

// `Cart.fetch_by(user:, browser_guid:)` is `user.carts.alive.first` (lowest id) or the guest cart for the guid, so only
// that one cart seeds.
async function cartProductIds(visitor: CuratedVisitor, guid: string | null, limit: number): Promise<bigint[]> {
  const rows = visitor
    ? await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("carts", "id")} FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${visitor.id} AND ${column("carts", "deleted_at")} IS NULL ORDER BY ${column("carts", "id")} ASC LIMIT 1`,
      )
    : guid
      ? await selectRows<{ id: bigint }>(
          Prisma.sql`SELECT ${column("carts", "id")} FROM ${table("carts")} WHERE ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL AND ${column("carts", "deleted_at")} IS NULL LIMIT 1`,
        )
      : [];
  const cartId = rows[0]?.id;
  if (cartId === undefined) return [];
  const products = await selectRows<{ product_id: bigint }>(
    Prisma.sql`SELECT ${column("cart_products", "product_id")} FROM ${table("cart_products")} WHERE ${column("cart_products", "cart_id")} = ${cartId} AND ${column("cart_products", "deleted_at")} IS NULL LIMIT ${Prisma.raw(String(limit))}`,
  );
  return products.map((row) => row.product_id);
}

// `User#purchased_products` joins links, so a purchase whose product row is gone seeds nothing.
async function purchasedProductIds(visitor: CuratedVisitor, limit: number): Promise<bigint[]> {
  if (!visitor) return [];
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column("links", "id")} FROM ${table("links")} INNER JOIN ${table("purchases")} ON ${column("links", "id")} = ${column("purchases", "link_id")} WHERE ${column("purchases", "purchaser_id")} = ${visitor.id} LIMIT ${Prisma.raw(String(limit))}`,
  );
  return rows.map((row) => row.id);
}

// BaseService#find_associated_product_ids, for the sizes whose result does not depend on a sample or an order. Each side
// is cut at 4 rows: a union that reaches 4 is handed back whatever the cut hid.
export async function associatedProductIds(visitor: CuratedVisitor, guid: string | null): Promise<bigint[]> {
  const cut = SAMPLED_FROM_ASSOCIATED_IDS;
  const union = new Set([...(await cartProductIds(visitor, guid, cut)), ...(await purchasedProductIds(visitor, cut))]);
  if (union.size >= SAMPLED_FROM_ASSOCIATED_IDS) return await unsampledAssociatedIds(visitor, guid);
  if (union.size > 0 && (await getRedis("main").get(ASSOCIATED_LIMIT_KEY)) !== null)
    throw new NotPortedError("Discover curated products with a custom associated product ids limit");
  return [...union];
}

// The set Rails samples from, when the sample cannot matter: no id of it has a cached related-products row, so every
// subset recommends nothing. A side that fills the default limit may have more ids than were read, and a custom limit
// changes the set, so both stay Rails'.
async function unsampledAssociatedIds(visitor: CuratedVisitor, guid: string | null): Promise<bigint[]> {
  if ((await getRedis("main").get(ASSOCIATED_LIMIT_KEY)) !== null)
    throw new NotPortedError("Discover curated products with a custom associated product ids limit");
  const cart = await cartProductIds(visitor, guid, DEFAULT_ASSOCIATED_LIMIT);
  const purchased = await purchasedProductIds(visitor, DEFAULT_ASSOCIATED_LIMIT);
  if (cart.length >= DEFAULT_ASSOCIATED_LIMIT || purchased.length >= DEFAULT_ASSOCIATED_LIMIT)
    throw new NotPortedError("Discover curated products sampled from a full associated ids limit");
  const ids = [...new Set([...cart, ...purchased])];
  const cached = await selectRows<{ product_id: bigint }>(
    Prisma.sql`SELECT ${column("cached_sales_related_products_infos", "product_id")} FROM ${table("cached_sales_related_products_infos")} WHERE ${columnIn("cached_sales_related_products_infos", "product_id", ids)} LIMIT 1`,
  );
  if (cached.length > 0) throw new NotPortedError("Discover curated products sampled from 4 or more associated ids");
  return [];
}

// CachedSalesRelatedProductsInfo#normalized_counts: { product_id => sales_count }
function normalizedCounts(raw: unknown): Map<bigint, number> {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const counts = new Map<bigint, number>();
  if (value === null || value === undefined) return counts;
  if (typeof value !== "object" || Array.isArray(value)) throw new NotPortedError("malformed related product counts");
  for (const [id, count] of Object.entries(value)) {
    if (!/^-?\d+$/u.test(id) || !Number.isSafeInteger(count))
      throw new NotPortedError("malformed related product counts");
    counts.set(BigInt(id), count as number);
  }
  return counts;
}

// SalesRelatedProductsInfo.related_products: the associated products' counts summed per related product, best seller
// first and the higher id first among equals, cut at `limit` before any filter runs.
export async function relatedProductIds(associated: bigint[], limit: number): Promise<bigint[]> {
  if (associated.length === 0) return [];
  const rows = await selectRows<{ counts: unknown }>(
    Prisma.sql`SELECT ${column("cached_sales_related_products_infos", "counts")} FROM ${table("cached_sales_related_products_infos")} WHERE ${columnIn("cached_sales_related_products_infos", "product_id", associated)}`,
  );
  const sums = new Map<bigint, number>();
  for (const row of rows)
    for (const [id, count] of normalizedCounts(row.counts)) sums.set(id, (sums.get(id) ?? 0) + count);
  for (const id of associated) sums.delete(id);
  return [...sums.entries()]
    .sort(([idA, countA], [idB, countB]) => countB - countA || (idB > idA ? 1 : idB < idA ? -1 : 0))
    .slice(0, limit)
    .map(([id]) => id);
}

// BaseService#exclude_product_ids: the associated products and what the purchased or carted bundles contain.
async function excludedProductIds(associated: bigint[]): Promise<Set<bigint>> {
  const bundled = await selectRows<{ product_id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${column("bundle_products", "product_id")} FROM ${table("bundle_products")} WHERE ${columnIn("bundle_products", "bundle_id", associated)} AND ${column("bundle_products", "deleted_at")} IS NULL`,
  );
  return new Set([...associated, ...bundled.map((row) => row.product_id)]);
}

// Link#rated_as_adult?
async function ratedAsAdult(row: LinkRow): Promise<boolean> {
  if (bit(row.flags, IS_ADULT_FLAG)) return true;
  const seller = row.user_id === null ? null : await findUserById(row.user_id);
  // Ruby raises on the missing seller and `curated_products` rescues it into an empty list.
  if (!seller) throw new NotPortedError("curated product without a seller");
  if (bit(seller.flags, ALL_ADULT_PRODUCTS_FLAG)) return true;
  return [row.name, row.description, seller.name, effectiveUsername(seller), seller.bio as string | null].some((text) =>
    isAdult(text),
  );
}

// The products in the order DiscoverService returns them: alive, not archived, not excluded and not rated as adult.
export async function curatedProducts(visitor: CuratedVisitor, guid: string | null): Promise<LinkRow[]> {
  const associated = await associatedProductIds(visitor, guid);
  const related = await relatedProductIds(associated, NUMBER_OF_RESULTS);
  if (related.length === 0) return [];
  const excluded = await excludedProductIds(associated);
  const curated: LinkRow[] = [];
  for (const id of related) {
    const row = await findLink(id);
    if (!row || excluded.has(row.id)) continue;
    if (row.purchase_disabled_at !== null || row.banned_at !== null || row.deleted_at !== null) continue;
    if (bit(row.flags, ARCHIVED_FLAG) || (await ratedAsAdult(row))) continue;
    curated.push(row);
  }
  return curated;
}

// The `taxonomies_for_nav` the product and wishlist pages' discover layouts send: DiscoverCuratedProducts#taxonomies_for_nav
// orders the nav by the root taxonomies of the visitor's curated products, the same list the Discover page uses.
export async function curatedTaxonomyIds(visitor: CuratedVisitor, guid: string | null): Promise<bigint[]> {
  const curated = await curatedProducts(visitor, guid);
  return curated.flatMap((row) => (row.taxonomy_id === null ? [] : [row.taxonomy_id as bigint]));
}
