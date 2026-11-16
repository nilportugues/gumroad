// Port of app/sidekiq/duplicate_product_worker.rb up to the duplication. `ProductDuplicatorService.new(product_id)` reads the product with
// `Link.find` in Node; the duplication itself is one write transaction (copies of prices, files, previews, rich content and S3 objects)
// and a product that is gone reports to Sentry first, so both hand back after that one read. The `ensure` that clears `is_duplicating`
// is a write and stays with Ruby.
// Golden: __fixtures__/duplicate-product-worker.golden.json (scripts/golden/duplicate-product-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const duplicateProductWorkerWith = modelJob({ min: 1 }, async ([productId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findById("Link", id);
  if (product === null) throw new HandBackToRuby("a missing product is reported to Sentry");
  throw new HandBackToRuby("ProductDuplicatorService#duplicate writes the copy");
});
export const duplicateProductWorker = duplicateProductWorkerWith();
