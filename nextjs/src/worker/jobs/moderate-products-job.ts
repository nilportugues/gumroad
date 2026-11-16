// Port of the product lookup of app/sidekiq/moderate_products_job.rb: no ids, and ids no product has, finish with the batch read Rails
// sends. A product that exists goes to ContentModeration::ModerateRecordService.check (an LLM call and the moderation writes), which stays
// with Rails: the job is handed back right after the first batch is read, before any product is checked. Ids that are not all Integers
// hand back before any statement, because Rails casts them.
// Golden: __fixtures__/moderate-products-job.golden.json (scripts/golden/moderate-products-job.rb); the moderation service was replaced by a
// recorder there.
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { columnIn, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const LINKS = "links";
const BATCH_SIZE = 1_000;

export const moderateProductsJobWith = modelJob({ min: 1 }, async ([productIds]) => {
  if (!Array.isArray(productIds) || !productIds.every((id) => typeof id === "number" && Number.isSafeInteger(id)))
    throw new HandBackToRuby("the product ids are not all Integers");
  // `where(id: [])` is `1=0`, which ActiveRecord answers without a statement
  if (productIds.length === 0) return;

  await findInBatches(LINKS, columnIn(LINKS, "id", productIds), BATCH_SIZE, () =>
    Promise.reject(new HandBackToRuby("ContentModeration::ModerateRecordService is not ported")),
  );
});

export const moderateProductsJob = moderateProductsJobWith();
