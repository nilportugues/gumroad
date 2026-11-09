// The versions (Variant rows in VariantCategory groups) of a non-membership product, as ProductPresenter#edit_props
// serves them, and the digests Product::EditorRevision takes of them.
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";

const INTEGRATION_NAMES = ["circle", "discord", "zoom", "google_calendar"] as const;
const ROW_DIGEST_LENGTH = 16;
const UNIT_SEPARATOR = "\x1f";

// base_variants and variant_categories columns in schema order, minus created_at / updated_at: neither table has a
// precise timestamp, so Product::EditorRevision digests every other column (`row_digests`).
const BASE_VARIANT_DIGEST_COLUMNS = [
  "id", "variant_category_id", "price_difference_cents", "name", "max_purchase_count", "deleted_at", "type", "link_id", "custom_sku", "flags",
  "description", "position_in_category", "customizable_price", "subscription_price_change_effective_date", "subscription_price_change_message",
  "duration_in_minutes", "sales_count_for_inventory_cache",
] as const;
const VARIANT_CATEGORY_DIGEST_COLUMNS = ["id", "link_id", "deleted_at", "title", "flags"] as const;
const BOOLEAN_COLUMNS = new Set(["customizable_price"]);

type RawRow = Record<string, unknown>;

// Ruby's `to_s` of a plucked value.
function rubyToS(name: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (BOOLEAN_COLUMNS.has(name)) return value === true || Number(value) === 1 ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// Port of app/services/product/editor_revision.rb `row_digests`: [id, first 16 hex of SHA256 over the columns joined by "\x1f"].
function rowDigests(rows: RawRow[], columns: readonly string[]): [number, string][] {
  return [...rows]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => [Number(row.id), createHash("sha256").update(columns.map((name) => rubyToS(name, row[name])).join(UNIT_SEPARATOR)).digest("hex").slice(0, ROW_DIGEST_LENGTH)]);
}

export type VersionRows = { categories: RawRow[]; variants: RawRow[] };

// `product.variant_categories.alive` and `BaseVariant.alive.where(variant_category_id: <those>)`, whatever the subtype.
export async function versionRows(productId: bigint): Promise<VersionRows> {
  const categories = await selectRows<RawRow>(
    Prisma.sql`SELECT ${Prisma.raw(VARIANT_CATEGORY_DIGEST_COLUMNS.map((name) => `\`variant_categories\`.\`${name}\``).join(", "))} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC`,
  );
  if (categories.length === 0) return { categories, variants: [] };
  const variants = await selectRows<RawRow>(
    Prisma.sql`SELECT ${Prisma.raw(BASE_VARIANT_DIGEST_COLUMNS.map((name) => `\`base_variants\`.\`${name}\``).join(", "))}, ${column("base_variants", "created_at")}, ${column("base_variants", "updated_at")} FROM ${table("base_variants")} WHERE ${column("base_variants", "deleted_at")} IS NULL AND ${column("base_variants", "variant_category_id")} IN (${Prisma.join(categories.map((category) => category.id))}) ORDER BY ${column("base_variants", "id")} ASC`,
  );
  return { categories, variants };
}

// The `variants` and `variant_categories` entries of Product::EditorRevision.fingerprint.
export function versionStamps({ categories, variants }: VersionRows) {
  return { variants: rowDigests(variants, BASE_VARIANT_DIGEST_COLUMNS), variant_categories: rowDigests(categories, VARIANT_CATEGORY_DIGEST_COLUMNS) };
}

// `Time#as_json` (ActiveSupport time precision 3, UTC).
const asJsonTime = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

// Port of app/models/concerns/rich_contents.rb#rich_content_json for a BaseVariant.
async function variantRichContents(variantIds: bigint[]) {
  if (variantIds.length === 0) return new Map<number, unknown[]>();
  const rows = await selectRows<{ id: bigint; entity_id: bigint; title: string | null; description: unknown; updated_at: Date }>(
    Prisma.sql`SELECT ${column("rich_contents", "id")}, ${column("rich_contents", "entity_id")}, ${column("rich_contents", "title")}, ${column("rich_contents", "description")}, ${column("rich_contents", "updated_at")} FROM ${table("rich_contents")} WHERE ${column("rich_contents", "entity_type")} = 'BaseVariant' AND ${column("rich_contents", "entity_id")} IN (${Prisma.join(variantIds)}) AND ${column("rich_contents", "deleted_at")} IS NULL ORDER BY ${column("rich_contents", "position")} ASC, ${column("rich_contents", "id")} ASC`,
  );
  const byVariant = new Map<number, unknown[]>();
  for (const row of rows) {
    const variantId = externalId(row.entity_id);
    const pages = byVariant.get(Number(row.entity_id)) ?? [];
    pages.push({
      id: externalId(row.id),
      page_id: externalId(row.id),
      title: row.title,
      variant_id: variantId,
      description: { type: "doc", content: typeof row.description === "string" ? (JSON.parse(row.description) as unknown) : row.description },
      updated_at: asJsonTime(row.updated_at),
    });
    byVariant.set(Number(row.entity_id), pages);
  }
  return byVariant;
}

// Product::StaleContentWriteGuard.snapshot_at: the newer of the version and its price rows (deleted ones count).
async function priceStamps(variantIds: bigint[]) {
  if (variantIds.length === 0) return new Map<number, Date>();
  const rows = await selectRows<{ variant_id: number; updated_at: Date | null }>(
    Prisma.sql`SELECT ${column("prices", "variant_id")}, MAX(${column("prices", "updated_at")}) AS updated_at FROM ${table("prices")} WHERE ${column("prices", "variant_id")} IN (${Prisma.join(variantIds)}) GROUP BY ${column("prices", "variant_id")}`,
  );
  return new Map(rows.filter((row) => row.updated_at !== null).map((row) => [Number(row.variant_id), row.updated_at as Date]));
}

const integrationFlags = () => Object.fromEntries(INTEGRATION_NAMES.map((name) => [name, false]));

// The `variants` prop of ProductPresenter#edit_props for a product whose versions have no files, integrations or sales
// (editBlockers), served in `in_order` (created_at; ties by id). `sharesRichContent` is the product's
// has_same_rich_content_for_all_variants flag, which hides the versions' own pages.
export async function variantProps({ variants }: VersionRows, sharesRichContent: boolean) {
  const versions = variants
    .filter((row) => row.type === "Variant")
    .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime() || Number(a.id) - Number(b.id));
  const ids = versions.map((row) => BigInt(row.id as number));
  const [pages, prices] = await Promise.all([sharesRichContent ? Promise.resolve(new Map<number, unknown[]>()) : variantRichContents(ids), priceStamps(ids)]);
  return versions.map((row) => {
    const id = Number(row.id);
    const rowStamp = row.updated_at as Date | null;
    const priceStamp = prices.get(id);
    const stamps = [rowStamp, priceStamp].filter((stamp): stamp is Date => stamp instanceof Date);
    const maxPurchaseCount = row.max_purchase_count as number | null;
    return {
      id: externalId(BigInt(id)),
      name: (row.name as string | null) || "",
      description: (row.description as string | null) || "",
      updated_at: asJsonTime(stamps.length === 0 ? null : new Date(Math.max(...stamps.map((stamp) => stamp.getTime())))),
      max_purchase_count: maxPurchaseCount,
      integrations: integrationFlags(),
      loaded_integrations: integrationFlags(),
      rich_content: pages.get(id) ?? [],
      has_files: false,
      // `max_purchase_count?` is false for nil and 0.
      sales_count_for_inventory: maxPurchaseCount ? Number(row.sales_count_for_inventory_cache) : 0,
      active_subscribers_count: 0,
      price_difference_cents: row.price_difference_cents as number | null,
    };
  });
}

// Whether any version of the product holds a live content page, the case `recoverable_hidden_variant_rich_content?`
// needs `RichContent#has_editor_content?` for when the shared-content flag is on.
export async function hasVariantRichContent(productId: bigint): Promise<boolean> {
  const [row] = await selectRows<{ present: number }>(
    Prisma.sql`SELECT 1 AS present FROM ${table("rich_contents")} INNER JOIN ${table("base_variants")} ON ${column("base_variants", "id")} = ${column("rich_contents", "entity_id")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("rich_contents", "entity_type")} = 'BaseVariant' AND ${column("rich_contents", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL LIMIT 1`,
  );
  return row !== undefined;
}
