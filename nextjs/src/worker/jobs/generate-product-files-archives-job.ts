// Port of app/sidekiq/generate_product_files_archives_job.rb up to `product.with_lock`. The `find_by(id:)` and the deleted check run
// in Node and finish a missing or deleted product; a live product means the locked transaction and the archive rebuild, which hand
// back to Rails before BEGIN, as does an id Rails casts. Golden: __fixtures__/generate-product-files-archives-job.golden.json
// (scripts/golden/generate-product-files-archives-job.rb).
import type { Link } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const generateProductFilesArchivesJobWith = modelJob({ min: 1 }, async ([productId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find_by"));
  const product = await findById<Link>("Link", id);
  if (product === null || product.deleted_at !== null) return;

  throw new HandBackToRuby("a live product's archives are rebuilt under its row lock");
});
export const generateProductFilesArchivesJob = generateProductFilesArchivesJobWith();
