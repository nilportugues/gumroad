// Port of app/sidekiq/cache_product_data_worker.rb: Link.find, Product::Caching#invalidate_cache, then
// `product_cached_values.create!`, whose before_create reads the five Link metrics (models/link-metrics.ts).
// A case the metrics cannot reproduce (a closed tier on a tiered membership, a bundle Sku variant) hands the job back to
// Rails after the cache expiry ran; Rails repeats that expiry harmlessly and creates the row.
// Golden: __fixtures__/cache-product-data-worker.golden.json (scripts/golden/cache-product-data-worker.rb).
import type { Link } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { invalidateProductCache } from "../../server/models/link.ts";
import { ProductCachedValues } from "../../server/models/product-cached-value.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const cacheProductDataWorkerWith = modelJob({ min: 1 }, async ([productIdArg], deps) => {
  const productId = await beforeSideEffects(() => recordIdFrom(productIdArg, "Link.find"));
  await findByIdBang<Link>("Link", productId);
  await invalidateProductCache(productId, deps.now);
  await beforeSideEffects(() => ProductCachedValues.createBang({ product_id: productId }, { now: deps.now }));
});

export const cacheProductDataWorker = cacheProductDataWorkerWith();
