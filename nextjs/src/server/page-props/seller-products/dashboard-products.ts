// DashboardProductsPagePresenter: the props of Products/Index and Products/Archived/Index.
import { Prisma, type User } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { LinkFlags } from "../../models/link.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import {
  collaboratingProductIds,
  linkPolicy,
  piracyReportsNew,
  productDuplicatesLinkPolicy,
  productsArchivedLinkPolicy,
} from "../../policies/link.ts";
import type { SellerContext } from "../../policies/seller-context.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";

import {
  assertPriceSupported,
  assertStatsCached,
  assertTableSupported,
  assertThumbnailsSupported,
  displayPriceCents,
  externalEditPath,
  freshCachedStats,
  hasDuration,
  type LinkRow,
  loadRowData,
  type ListingParams,
  type Page,
  priceFormattedVerbose,
  productFlag,
  productUrls,
  sortAndPaginate,
  type TableParams,
  thumbnailJson,
} from "./listing.ts";

export type TableKind = "products" | "memberships";

const present = (value: string | null): value is string => value !== null && value.trim() !== "";

function likeName(query: string | null): Prisma.Sql {
  return present(query) ? Prisma.sql` AND ${column("links", "name")} LIKE ${`%${query}%`}` : Prisma.empty;
}

// `seller.products.{non_membership,membership}.visible.{archived,not_archived}` (+ the name search)
function tableQuery(seller: User, kind: TableKind, archived: boolean, params: ListingParams) {
  return {
    from: Prisma.sql`${table("links")}`,
    where: Prisma.sql`${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("is_recurring_billing", kind === "memberships")} AND ${LinkFlags.condition("archived", archived)}${likeName(params.query)}`,
  };
}

export type ArchivedCounts = { hasProducts: boolean };

// The page of rows a table shows, before any per-row work.
export async function tableRows(
  seller: User,
  kind: TableKind,
  archived: boolean,
  params: ListingParams,
): Promise<{ pagination: Page; rows: LinkRow[] }> {
  const { from, where } = tableQuery(seller, kind, archived, params);
  return sortAndPaginate({ from, where, table: params[kind], sellerId: seller.id });
}

// Everything that sends the page to Rails, checked ahead of the render.
export async function assertListingSupported(
  seller: User,
  archived: boolean,
  params: ListingParams,
): Promise<{ products: LinkRow[]; memberships: LinkRow[] }> {
  assertTableSupported(params.products);
  assertTableSupported(params.memberships);
  const [products, memberships] = await Promise.all([
    tableRows(seller, "products", archived, params),
    tableRows(seller, "memberships", archived, params),
  ]);
  const rows = [...products.rows, ...memberships.rows];
  const data = await loadRowData(rows);
  await assertThumbnailsSupported(data);
  for (const row of rows) assertPriceSupported(row, data);
  assertStatsCached(rows, await freshCachedStats(rows));
  return { products: products.rows, memberships: memberships.rows };
}

const CHARGED_STATES = ["preorder_authorization_successful", "successful", "preorder_concluded_successfully"];

// The PurchaseSearchService options of Link#total_usd_cents
export const totalUsdCentsOptions = (productId: bigint) => ({
  state: CHARGED_STATES,
  exclude_giftees: true,
  exclude_refunded: true,
  exclude_unreversed_chargedback: true,
  exclude_non_successful_preorder_authorizations: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
  product: Number(productId),
  size: 0,
  aggs: {
    price_cents_total: { sum: { field: "price_cents" } },
    amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
  },
});

// Link#total_usd_cents
export async function totalUsdCents(productId: bigint): Promise<number> {
  const result = await PurchaseSearchService.process(totalUsdCentsOptions(productId));
  const aggregations = result.response.aggregations as Record<string, { value: number }>;
  return aggregations.price_cents_total!.value - aggregations.amount_refunded_cents_total!.value;
}

function status(product: LinkRow): string {
  if (product.draft || product.purchase_disabled_at) return "unpublished";
  return productFlag(product.flags, "is_in_preorder_state") ? "preorder" : "published";
}

// product_base_data merged with the cached stats (Product::Caching.dashboard_collection_data)
async function rowsData(seller: User, context: SellerContext, rows: LinkRow[]): Promise<Record<string, unknown>[]> {
  const data = await loadRowData(rows);
  await assertThumbnailsSupported(data);
  const stats = await freshCachedStats(rows);
  assertStatsCached(rows, stats);
  const collaborating = await collaboratingProductIds(
    context,
    rows.map((row) => row.id),
  );
  const reportable = await piracyReportsNew(context, await isFeatureEnabled("piracy_reports", userActor(seller.id)));
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    assertPriceSupported(row, data);
    const urls = productUrls(row, seller);
    const cached = stats.get(row.id)!;
    result.push({
      id: Number(row.id),
      edit_url: externalEditPath(row),
      is_duplicating: productFlag(row.flags, "is_duplicating"),
      is_unpublished: !!row.draft || row.purchase_disabled_at !== null,
      name: row.name,
      permalink: row.unique_permalink,
      price_formatted: priceFormattedVerbose(row, data),
      revenue: await totalUsdCents(row.id),
      status: status(row),
      thumbnail: thumbnailJson(row, data),
      display_price_cents: displayPriceCents(row, data),
      url: urls.url,
      url_without_protocol: urls.url_without_protocol,
      has_duration: hasDuration(row),
      can_edit: linkPolicy.edit(context, row, collaborating),
      can_destroy: linkPolicy.destroy(context),
      can_duplicate: productDuplicatesLinkPolicy.create(context),
      can_archive: productsArchivedLinkPolicy.create(context, row),
      can_unarchive: productsArchivedLinkPolicy.destroy(context, row),
      can_report_piracy: reportable,
      ...cached,
    });
  }
  return result;
}

export async function tableData(
  seller: User,
  context: SellerContext,
  kind: TableKind,
  archived: boolean,
  params: ListingParams,
) {
  const { pagination, rows } = await tableRows(seller, kind, archived, params);
  return { [kind]: await rowsData(seller, context, rows), pagination, sort: params[kind].sort } as Record<
    string,
    unknown
  >;
}

// `seller.products.visible.not_archived.exists?` / `seller.products.archived.exists?` (the latter is not `visible`)
export async function hasProducts(seller: User, archived: boolean): Promise<boolean> {
  const alive = archived ? Prisma.empty : Prisma.sql` AND ${column("links", "deleted_at")} IS NULL`;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id}${alive} AND ${LinkFlags.condition("archived", archived)} LIMIT 1`,
  );
  return rows.length > 0;
}

// User#archived_products_count
export async function archivedProductsCount(seller: User): Promise<number> {
  const [row] = await selectRows<{ count: bigint }>(
    Prisma.sql`SELECT COUNT(*) AS count FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", true)}`,
  );
  return Number(row?.count ?? 0);
}

export type { TableParams };
