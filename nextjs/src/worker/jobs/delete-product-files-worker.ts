// Port of app/sidekiq/delete_product_files_worker.rb up to the first ProductFile#delete!: a missing product fails with RecordNotFound,
// one whose deletion was undone and one that still has successful sales (an Elasticsearch count) finish here, and so does a deleted
// product with no file rows. A file to delete is handed back to Rails before any write: delete! soft-deletes the row through
// PaperTrail, the cache invalidation, the HLS rendition cleanup and the subtitle file deletes, none of which are ported. Golden:
// __fixtures__/delete-product-files-worker.golden.json (scripts/golden/delete-product-files-worker.rb).
import { Prisma, type Link } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { hasSuccessfulSales } from "../../server/models/link-metrics.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PRODUCT_FILES = "product_files";

export const deleteProductFilesWorkerWith = modelJob({ min: 1 }, async ([productArg]) => {
  // `Link.find(nil)` raises before a query; a Float or a word is cast by the column in ways Node does not reproduce.
  if (productArg === null) throw new RecordNotFound("Couldn't find Link without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(productArg, "Link.find"));
  const product = await findByIdBang<Link>("Link", id);
  // user undid product deletion
  if (product.deleted_at === null) return;
  if (await hasSuccessfulSales(product)) return;

  const files = await selectRows(
    Prisma.sql`SELECT ${table(PRODUCT_FILES)}.* FROM ${table(PRODUCT_FILES)} WHERE ${column(PRODUCT_FILES, "link_id")} = ${id}`,
  );
  if (files.length > 0)
    throw new HandBackToRuby("ProductFile#delete! is not ported (PaperTrail, cache and HLS cleanup, subtitle files)");
});

export const deleteProductFilesWorker = deleteProductFilesWorkerWith();
