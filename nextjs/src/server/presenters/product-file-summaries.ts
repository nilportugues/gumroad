// Product::FileSummaryService: what a buyer receives before purchase (formats, total size, file count), never names or URLs.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { LinkFlags } from "../models/link.ts";
import { embeddedProductFileIds, type DescriptionNode } from "../models/rich-content-description.ts";
import { hasEditorContent } from "../models/rich-content.ts";
import { column, inList, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import type { LinkRow } from "./product-reads.ts";

export type FileSummary = { formats: string[]; total_size: number | null; count: number };
export type FileSummaries = { product: FileSummary | null; options: Record<string, FileSummary> };

type Provider = { entityType: "Link" | "BaseVariant"; id: bigint };
type PageRow = { entity_id: bigint; title: string | null; description: unknown };

const EXTERNAL_LINK_FILETYPE = "link";

const flagSet = (row: LinkRow, name: Parameters<typeof LinkFlags.isSet>[1]) =>
  LinkFlags.isSet(row.flags as bigint | number, name);

async function alivePages(entityType: Provider["entityType"], ids: bigint[]): Promise<PageRow[]> {
  if (ids.length === 0) return [];
  return selectRows<PageRow>(
    Prisma.sql`SELECT ${column("rich_contents", "entity_id")}, ${column("rich_contents", "title")}, ${column("rich_contents", "description")} FROM ${table("rich_contents")} WHERE ${column("rich_contents", "entity_type")} = ${entityType} AND ${column("rich_contents", "entity_id")} IN ${inList(ids)} AND ${column("rich_contents", "deleted_at")} IS NULL`,
  );
}

async function aliveVariantIds(productId: bigint): Promise<bigint[]> {
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL AND ${column("variant_categories", "link_id")} = ${productId} AND ${column("variant_categories", "deleted_at")} IS NULL`,
  );
  return rows.map((row) => BigInt(row.id));
}

// Link#has_product_level_rich_content? for a product that is not physical.
async function hasProductLevelRichContent(row: LinkRow): Promise<boolean> {
  const variantIds = await aliveVariantIds(row.id);
  if (variantIds.length === 0) return true;
  if (!flagSet(row, "has_same_rich_content_for_all_variants")) return false;
  // recoverable_hidden_variant_rich_content?: no visible product-level page, a visible version page.
  if ((await alivePages("Link", [row.id])).some(hasEditorContent)) return true;
  return !(await alivePages("BaseVariant", variantIds)).some(hasEditorContent);
}

function embeddedIds(pages: PageRow[]): Set<number> {
  const ids = new Set<number>();
  for (const page of pages) {
    const nodes = typeof page.description === "string" ? (JSON.parse(page.description) as unknown) : page.description;
    if (nodes === null || nodes === undefined) continue;
    // `Array(nodes)` of a hash is its pairs; the JSON schema only lets arrays through.
    if (!Array.isArray(nodes))
      throw new NotPortedError("FileSummaryService with a page whose description is not a list");
    for (const id of embeddedProductFileIds(nodes as DescriptionNode[])) ids.add(id);
  }
  return ids;
}

// Mirrors UrlRedirect#alive_product_files: the files embedded in the pages when there are any.
async function summarize(provider: Provider, pages: PageRow[]): Promise<FileSummary | null> {
  const embedded = embeddedIds(pages);
  const files = await selectRows<{ id: bigint; filetype: string | null; size: bigint | null }>(
    provider.entityType === "Link"
      ? Prisma.sql`SELECT ${column("product_files", "id")}, ${column("product_files", "filetype")}, ${column("product_files", "size")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${provider.id} AND ${column("product_files", "deleted_at")} IS NULL`
      : Prisma.sql`SELECT ${column("product_files", "id")}, ${column("product_files", "filetype")}, ${column("product_files", "size")} FROM ${table("product_files")} INNER JOIN ${table("base_variants_product_files")} ON ${column("base_variants_product_files", "product_file_id")} = ${column("product_files", "id")} WHERE ${column("base_variants_product_files", "base_variant_id")} = ${provider.id} AND ${column("product_files", "deleted_at")} IS NULL`,
  );
  const delivered = (embedded.size > 0 ? files.filter((file) => embedded.has(Number(file.id))) : files).filter(
    (file) => file.filetype !== EXTERNAL_LINK_FILETYPE,
  );
  if (delivered.length === 0) return null;
  const formats = [
    ...new Set(
      delivered.flatMap((file) => {
        const format = (file.filetype ?? "").toUpperCase();
        return /^\s*$/u.test(format) ? [] : [format];
      }),
    ),
  ].sort();
  return {
    formats,
    total_size: delivered.some((file) => file.size === null)
      ? null
      : Number(delivered.reduce((sum, file) => sum + BigInt(file.size!), 0n)),
    count: delivered.length,
  };
}

export async function fileSummaries(row: LinkRow, optionIds: bigint[]): Promise<FileSummaries> {
  if (flagSet(row, "is_physical") || flagSet(row, "is_bundle")) return { product: null, options: {} };
  const shared = await hasProductLevelRichContent(row);
  const options: Record<string, FileSummary> = {};
  if (shared) {
    const product = await summarize({ entityType: "Link", id: row.id }, await alivePages("Link", [row.id]));
    if (product) for (const id of optionIds) options[encrypt(id)] = product;
    return { product, options };
  }
  const pages = await alivePages("BaseVariant", optionIds);
  for (const id of optionIds) {
    const summary = await summarize(
      { entityType: "BaseVariant", id },
      pages.filter((page) => BigInt(page.entity_id) === id),
    );
    if (summary) options[encrypt(id)] = summary;
  }
  return { product: null, options };
}
