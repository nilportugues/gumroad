// Port of Product::DisableDownloadsForAllFiles (app/services/product/disable_downloads_for_all_files.rb): under the product row lock,
// every alive eligible file is switched to stream-only and GenerateProductFilesArchivesJob is queued once the lock is released.
//
// Handed back as NotPortedError before the first write: a flip would need `invalidate_stale_product_files_archives!` to delete an alive
// archive (the product has one), a flipped file with PDF stamping (its commit callback is not ported), or two flipped files that share a
// position (the order of `disabled_file_ids` is then the database's).
import type { ProductFile } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { loadProductFile, ProductFiles } from "./product-file-writes.ts";
import { canDisableDownloads, isStreamOnly, ProductFileFlags } from "./product-file.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const FILE = "app/services/product/disable_downloads_for_all_files.rb";

export type DisableDownloadsResult = {
  disabled_file_ids: string[];
  already_disabled_count: number;
  ineligible_count: number;
};

const handBack = (what: string): never => {
  throw new NotPortedError(what, FILE);
};

const hasAliveArchive = async (productId: bigint) =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table("product_files_archives")} WHERE ${column("product_files_archives", "deleted_at")} IS NULL AND (${column("product_files_archives", "link_id")} = ${productId} OR ${column("product_files_archives", "variant_id")} IN (SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("variant_categories", "link_id")} = ${productId})) LIMIT 1`,
    )
  ).length > 0;

export async function disableDownloadsForAllFiles(
  productId: bigint,
  options: { now?: () => Date } = {},
): Promise<DisableDownloadsResult> {
  const now = options.now ?? (() => new Date());
  let result: DisableDownloadsResult = { disabled_file_ids: [], already_disabled_count: 0, ineligible_count: 0 };
  await transaction(async () => {
    // product.with_lock: lock!, which reloads the row under FOR UPDATE.
    const [productRow] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1 FOR UPDATE`,
    );
    if (productRow === undefined) return handBack("a product that is gone");
    const product = castRow<Record<string, unknown>>("Link", productRow);
    const files = (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`product_files`.*")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${productId} AND ${column("product_files", "deleted_at")} IS NULL ORDER BY ${column("product_files", "position")} ASC`,
      )
    ).map((row) => castRow<ProductFile>("ProductFile", row));

    const flips = files.filter((file) => canDisableDownloads(file) && !isStreamOnly(file));
    const ineligible = files.filter((file) => !canDisableDownloads(file)).length;
    if (flips.length > 0) {
      if (flips.some((file) => ProductFileFlags.isSet(file.flags, "pdf_stamp_enabled")))
        handBack("a flipped file with PDF stamping");
      if (new Set(flips.map((file) => file.position)).size !== flips.length)
        handBack("flipped files that share a position");
      if (await hasAliveArchive(productId)) handBack("a product with an alive files archive");
    }

    for (const file of flips) {
      const record = loadProductFile(file, product);
      await ProductFiles.updateBang(record, { flags: ProductFileFlags.set(file.flags, "stream_only", true) }, { now });
    }
    result = {
      disabled_file_ids: flips.map((file) => encrypt(file.id)),
      already_disabled_count: files.filter((file) => canDisableDownloads(file) && isStreamOnly(file)).length,
      ineligible_count: ineligible,
    };
  });
  // Queued outside the lock: the job reads the committed files.
  if (result.disabled_file_ids.length > 0) await performAsync("GenerateProductFilesArchivesJob", [Number(productId)]);
  return result;
}
