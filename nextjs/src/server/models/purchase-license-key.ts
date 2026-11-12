// Purchase#variant_content_permits_license_key? and the Link reads under it (has_product_level_rich_content?), in Rails' statement
// order. Shared by CreateLicensesForExistingCustomersWorker (golden-proven) and the customers page.
// Golden: worker/jobs/__fixtures__/create-licenses-for-existing-customers-worker.golden.json.
import { Prisma } from "@prisma/client";

import { LinkFlags } from "./link.ts";
import { hasEditorContent, hasLicenseKey } from "./rich-content.ts";
import { column, selectRows, table } from "./sql.ts";

type Row = Record<string, unknown>;

// `link.alive_variants`: Variants of alive categories.
const ALIVE_VARIANTS_FROM = Prisma.sql`FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")}`;
const aliveVariantsWhere = (productId: unknown) =>
  Prisma.sql`WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL`;

// `alive_rich_contents` of a Link or a BaseVariant
const alivePages = (entityId: unknown, type: "Link" | "BaseVariant") =>
  selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`rich_contents`.*")} FROM ${table("rich_contents")} WHERE ${column("rich_contents", "entity_id")} = ${entityId} AND ${column("rich_contents", "entity_type")} = ${type} AND ${column("rich_contents", "deleted_at")} IS NULL`,
  );

const hasEditorPage = (page: Row) =>
  hasEditorContent({ title: page.title as string | null, description: page.description });

// Link#recoverable_hidden_variant_rich_content?, once the product shares its content across variants and is not physical.
async function recoverableHiddenVariantContent(product: Row): Promise<boolean> {
  if ((await alivePages(product.id, "Link")).some(hasEditorPage)) return false;
  const variants = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} ${ALIVE_VARIANTS_FROM} ${aliveVariantsWhere(product.id)}`,
  );
  for (const variant of variants) {
    if ((await alivePages(variant.id, "BaseVariant")).some(hasEditorPage)) return true;
  }
  return false;
}

// Link#has_product_level_rich_content?
async function hasProductLevelRichContent(product: Row): Promise<boolean> {
  if (LinkFlags.isSet(product.flags as bigint, "is_physical")) return true;
  const [alive] = await selectRows<Row>(
    Prisma.sql`SELECT 1 AS one ${ALIVE_VARIANTS_FROM} ${aliveVariantsWhere(product.id)} LIMIT 1`,
  );
  if (alive === undefined) return true;
  return (
    LinkFlags.isSet(product.flags as bigint, "has_same_rich_content_for_all_variants") &&
    !(await recoverableHiddenVariantContent(product))
  );
}

// Purchase#variant_content_permits_license_key?
export async function variantContentPermitsLicenseKey(purchase: Row, product: Row): Promise<boolean> {
  if (await hasProductLevelRichContent(product)) return true;

  const variants = await selectRows<Row>(
    Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} INNER JOIN ${table("base_variants_purchases")} ON ${column("base_variants", "id")} = ${column("base_variants_purchases", "base_variant_id")} WHERE ${column("base_variants_purchases", "purchase_id")} = ${purchase.id}`,
  );
  const pages: Row[] = [];
  for (const variant of variants) pages.push(...(await alivePages(variant.id, "BaseVariant")));
  return pages.length === 0 || pages.some((page) => hasLicenseKey(page.description));
}
