// UserPresenter#products_for_filter_box, #affiliate_products_for_filter_box and #audience_types.
import { Prisma, type User } from "@prisma/client";

import { column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";

// Link flags (flag_shih_tzu: flag n is bit n - 1).
const LINK_FLAG_ARCHIVED = 2 ** 4;
const LINK_FLAG_IS_PHYSICAL = 2 ** 7;
// BaseVariant flag 1
const VARIANT_FLAG_IS_DEFAULT_SKU = 1;

type LinkRow = { id: number | bigint; name: string; unique_permalink: string; flags: bigint | number };

export type FilterProduct = {
  id: number;
  name: string;
  unique_permalink: string;
  archived: boolean;
  physical: boolean;
  // `skus_alive_not_default` for a physical product, `alive_variants` otherwise.
  variants: { id: number; name: string | null }[];
};

// `product.archived? && !product.has_successful_sales?`: the sales count reads Elasticsearch.
function rejectArchivedWithoutSales(products: LinkRow[]): LinkRow[] {
  if (products.some((product) => (Number(product.flags) & LINK_FLAG_ARCHIVED) > 0)) {
    throw new NotPortedError("Product#has_successful_sales? for an archived product (PurchaseSearchService)");
  }
  return products;
}

async function variantsOf(products: LinkRow[]): Promise<Map<number, { id: number; name: string | null }[]>> {
  const result = new Map<number, { id: number; name: string | null }[]>(products.map((product) => [Number(product.id), []]));
  if (products.length === 0) return result;
  const physical = products.filter((product) => (Number(product.flags) & LINK_FLAG_IS_PHYSICAL) > 0).map((product) => Number(product.id));
  const digital = products.filter((product) => (Number(product.flags) & LINK_FLAG_IS_PHYSICAL) === 0).map((product) => Number(product.id));
  if (digital.length > 0) {
    const rows = await selectRows<{ id: number; name: string | null; link_id: number }>(
      Prisma.sql`SELECT ${column("base_variants", "id")}, ${column("base_variants", "name")}, ${column("variant_categories", "link_id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("variant_categories", "link_id")} IN (${Prisma.join(digital)}) AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' ORDER BY ${column("base_variants", "id")} ASC`,
    );
    for (const row of rows) result.get(Number(row.link_id))!.push({ id: row.id, name: row.name });
  }
  if (physical.length > 0) {
    const rows = await selectRows<{ id: number; name: string | null; link_id: number }>(
      Prisma.sql`SELECT ${column("base_variants", "id")}, ${column("base_variants", "name")}, ${column("base_variants", "link_id")} FROM ${table("base_variants")} WHERE ${column("base_variants", "link_id")} IN (${Prisma.join(physical)}) AND ${column("base_variants", "type")} = 'Sku' AND ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "flags")} & ${VARIANT_FLAG_IS_DEFAULT_SKU}) = 0 ORDER BY ${column("base_variants", "id")} ASC`,
    );
    for (const row of rows) result.get(Number(row.link_id))!.push({ id: row.id, name: row.name });
  }
  return result;
}

const toFilterProduct = (product: LinkRow, variants: Map<number, { id: number; name: string | null }[]>): FilterProduct => ({
  id: Number(product.id),
  name: product.name,
  unique_permalink: product.unique_permalink,
  archived: (Number(product.flags) & LINK_FLAG_ARCHIVED) > 0,
  physical: (Number(product.flags) & LINK_FLAG_IS_PHYSICAL) > 0,
  variants: variants.get(Number(product.id)) ?? [],
});

const visibleLinks = (seller: User, order: string) =>
  selectRows<LinkRow>(Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "user_id")} = ${seller.id} AND ${column("links", "deleted_at")} IS NULL ORDER BY ${Prisma.raw(order)}`);

// UserPresenter#products_for_filter_box
export async function productsForFilterBox(seller: User): Promise<FilterProduct[]> {
  const products = rejectArchivedWithoutSales(await visibleLinks(seller, "`links`.`id` ASC"));
  const variants = await variantsOf(products);
  return products.map((product) => toFilterProduct(product, variants));
}

// UserPresenter#affiliate_products_for_filter_box
export async function affiliateProductsForFilterBox(seller: User): Promise<FilterProduct[]> {
  const products = rejectArchivedWithoutSales(await visibleLinks(seller, "created_at DESC"));
  return products.map((product) => toFilterProduct(product, new Map()));
}

// UserPresenter#audience_types
export async function audienceTypes(seller: User): Promise<string[]> {
  const result: string[] = [];
  for (const [flag, type] of [["customer", "customers"], ["follower", "followers"], ["affiliate", "affiliates"]] as const) {
    const rows = await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("audience_members")} WHERE ${column("audience_members", "seller_id")} = ${seller.id} AND ${column("audience_members", flag)} = 1 LIMIT 1`,
    );
    if (rows.length > 0) result.push(type);
  }
  return result;
}
