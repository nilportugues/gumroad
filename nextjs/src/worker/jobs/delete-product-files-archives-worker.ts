// Port of app/sidekiq/delete_product_files_archives_worker.rb up to the first ProductFilesArchive#mark_deleted!: nothing to do, a
// product (or variant) whose deletion was undone, and a deleted one with no live archive finish here. A live archive to delete is
// handed back to Rails before any write (the soft delete runs PaperTrail and CdnDeletable callbacks). Golden:
// __fixtures__/delete-product-files-archives-worker.golden.json (scripts/golden/delete-product-files-archives-worker.rb).
import { Prisma, type BaseVariant, type Link } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const ARCHIVES = "product_files_archives";

// `owner.product_files_archives.alive.each(&:mark_deleted!)`: the load runs in Rails too, so a live archive is where Node stops.
async function handBackIfLiveArchives(ownerColumn: "link_id" | "variant_id", ownerId: unknown) {
  const rows = await selectRows(
    Prisma.sql`SELECT ${table(ARCHIVES)}.* FROM ${table(ARCHIVES)} WHERE ${column(ARCHIVES, ownerColumn)} = ${ownerId} AND ${column(ARCHIVES, "deleted_at")} IS NULL`,
  );
  if (rows.length > 0)
    throw new NotPortedError(
      "ProductFilesArchive#mark_deleted!",
      "delete_product_files_archives_worker.rb (PaperTrail, CdnDeletable)",
    );
}

// nil is blank; Ruby's other blanks ("", false) and any non-id are Ruby errors Node does not reproduce.
const idOrNull = (value: unknown, call: string) => (value === null ? null : recordIdFrom(value, call));

export const deleteProductFilesArchivesWorkerWith = modelJob(
  { min: 0, max: 2 },
  async ([productArg = null, variantArg = null]) => {
    if (productArg === null && variantArg === null) return;
    const productId = await beforeSideEffects(() => idOrNull(productArg, "Link.find"));
    const variantId = await beforeSideEffects(() => idOrNull(variantArg, "BaseVariant.find"));

    const variant = variantId === null ? null : await findByIdBang<BaseVariant>("BaseVariant", variantId);
    let productKey = productId;
    if (productKey === null) {
      // `Link.find(variant.variant_category.link_id)`: a SKU has no category, and a dangling one is a NoMethodError in Rails.
      const category = await findOneBy<{ link_id: bigint | number | null }>(
        "VariantCategory",
        "id",
        variant!.variant_category_id,
      );
      if (category === null || category.link_id === null) {
        await beforeSideEffects(() => {
          throw new NotPortedError(
            "Link.find(variant.variant_category.link_id)",
            "the variant has no category or the category no product",
          );
        });
      }
      productKey = BigInt(category!.link_id!);
    }
    const product = await findByIdBang<Link>("Link", productKey);

    if (variant !== null) {
      if (variant.deleted_at === null) return;
      await beforeSideEffects(async () => {
        // Only Variant has product_files_archives; a deleted SKU raises NoMethodError in Rails.
        if (variant.type !== "Variant")
          throw new NotPortedError("Sku#product_files_archives", "delete_product_files_archives_worker.rb");
        await handBackIfLiveArchives("variant_id", variant.id);
      });
      return;
    }

    if (product.deleted_at === null) return;
    await beforeSideEffects(async () => {
      await handBackIfLiveArchives("link_id", product.id);
      const variants = await selectRows<{ id: unknown }>(
        Prisma.sql`SELECT ${table("base_variants")}.* FROM ${table("base_variants")} INNER JOIN ${table("variant_categories")} ON ${column("base_variants", "variant_category_id")} = ${column("variant_categories", "id")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "deleted_at")} IS NULL`,
      );
      for (const row of variants) await handBackIfLiveArchives("variant_id", row.id);
    });
  },
);
export const deleteProductFilesArchivesWorker = deleteProductFilesArchivesWorkerWith();
