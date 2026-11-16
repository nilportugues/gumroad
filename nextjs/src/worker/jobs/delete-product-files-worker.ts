// Port of app/sidekiq/delete_product_files_worker.rb: a product whose deletion was undone or with a successful sale (one sales
// search) finishes early; a search answer Ruby cannot read fails with its NoMethodError. Each file is soft-deleted through
// ProductFile#delete! (models/product-file-writes.ts: validations, PaperTrail, cache invalidation, HLS renditions, subtitle files).
// The commit callback after each save classifies the product's taxonomy attributes (models/taxonomy-attribute-classifier.ts), which
// rewrites the product's inferred values. An id Rails casts (a Float, a word) hands back before any statement.
// Golden: __fixtures__/delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb).
import { Prisma, type Link, type ProductFile } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { ACTIVE_SALES_SEARCH_OPTIONS } from "../../server/models/link-metrics.ts";
import { deleteProductFileBang, loadProductFile } from "../../server/models/product-file-writes.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { PurchaseSearchService } from "../../server/search/purchase-search.ts";

import { RubyNoMethodError } from "./calculate-sale-numbers-worker.ts";
import { modelJob } from "./support/job-deps.ts";

class RubyArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

// Link#has_successful_sales?: `results.total > 0` over the active sales of the product, with the default total hits.
async function hasSuccessfulSales(productId: bigint): Promise<boolean> {
  const { response } = await PurchaseSearchService.process({
    ...ACTIVE_SALES_SEARCH_OPTIONS,
    product: Number(productId),
    size: 0,
    track_total_hits: null,
  });
  // The answer is whatever the server sent, not the shape the type promises.
  const hits = response.hits as { total?: unknown } | null | undefined;
  if (hits === undefined || hits === null) throw new RubyNoMethodError("undefined method '[]' for nil");
  const total = hits.total;
  if (total !== undefined && total !== null && typeof total !== "object") {
    throw new HandBackToRuby("a search answer whose total is not an object");
  }
  const value: unknown = (total as { value?: unknown } | undefined | null)?.value ?? null;
  if (value === null) throw new RubyNoMethodError("undefined method '>' for nil");
  if (typeof value === "string") throw new RubyArgumentError("comparison of String with 0 failed");
  if (typeof value === "boolean") throw new RubyNoMethodError(`undefined method '>' for ${String(value)}`);
  if (typeof value !== "number") throw new HandBackToRuby("a search answer whose total is an array or an object");
  return value > 0;
}

export const deleteProductFilesWorkerWith = modelJob({ min: 1 }, async ([productId], deps) => {
  if (productId === null) throw new RecordNotFound("Couldn't find Link without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findOneBy<Link>("Link", "id", id);
  if (product === null) throw new RecordNotFound(`Couldn't find Link with 'id'=${String(id)}`);
  if (product.deleted_at === null) return;
  if (await hasSuccessfulSales(id)) return;

  const files = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`product_files`.*")} FROM ${table("product_files")} WHERE ${column("product_files", "link_id")} = ${id}`,
  );
  if (files.length === 0) return;

  for (const row of files) {
    await deleteProductFileBang(
      loadProductFile(castRow<ProductFile>("ProductFile", row), product as unknown as Record<string, unknown>),
      {
        now: deps.now,
      },
    );
  }
});

export const deleteProductFilesWorker = deleteProductFilesWorkerWith();
