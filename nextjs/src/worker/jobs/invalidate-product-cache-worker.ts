// Port of app/sidekiq/invalidate_product_cache_worker.rb: Link.find then Product::Caching#invalidate_cache.
// Golden: __fixtures__/invalidate-product-cache-worker.golden.json (scripts/golden/invalidate-product-cache-worker.rb).
import type { Link } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { invalidateProductCache } from "../../server/models/link.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const invalidateProductCacheWorkerWith = modelJob({ min: 1 }, async ([productIdArg], deps) => {
  const productId = await beforeSideEffects(() => recordIdFrom(productIdArg, "Link.find"));
  await findByIdBang<Link>("Link", productId);
  await invalidateProductCache(productId, deps.now);
});

export const invalidateProductCacheWorker = invalidateProductCacheWorkerWith();
