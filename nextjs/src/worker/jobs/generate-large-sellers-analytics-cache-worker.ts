// Port of app/sidekiq/generate_large_sellers_analytics_cache_worker.rb up to the first large seller. The `find_each` over users joined to
// `large_sellers` runs in Node and finishes a run with none; a large seller means CreatorAnalytics::CachingProxy#generate_cache
// (analytics queries and cache writes), which hands back to Rails before anything is written.
// Golden: __fixtures__/generate-large-sellers-analytics-cache-worker.golden.json
// (scripts/golden/generate-large-sellers-analytics-cache-worker.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { column, findInBatches, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;

// User.joins(:large_seller)
const largeSellerJoin = Prisma.sql`INNER JOIN ${table("large_sellers")} ON ${column("large_sellers", "user_id")} = ${column("users", "id")}`;

export const generateLargeSellersAnalyticsCacheWorkerWith = modelJob({ min: 0 }, async () => {
  await findInBatches(
    "users",
    null,
    FIND_EACH_BATCH_SIZE,
    () => {
      throw new HandBackToRuby("a large seller whose analytics cache is regenerated");
    },
    null,
    largeSellerJoin,
  );
});
export const generateLargeSellersAnalyticsCacheWorker = generateLargeSellersAnalyticsCacheWorkerWith();
