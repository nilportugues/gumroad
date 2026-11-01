// Ports of app/sidekiq/send_to_elasticsearch_worker.rb,
// refresh_user_products_recommendation_eligibility_job.rb,
// refresh_merchant_account_products_recommendation_eligibility_job.rb and
// reindex_recommendable_products_worker.rb; the bodies are src/server/search/product-indexing.ts.
import { isFeatureEnabled } from "../../server/infra/flipper.ts";
import { withJobsRuntime } from "../../server/models/concerns/job-runtime.ts";
import {
  type ProductIndexingDeps,
  refreshProductsRecommendationEligibility,
  reindexRecommendableProducts,
  sendToElasticsearch,
} from "../../server/search/product-indexing.ts";
import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

export const defaultProductIndexingDeps: ProductIndexingDeps = {
  now: () => new Date(),
  featureActive: (name, actor) => isFeatureEnabled(name, actor),
};

type Body = (args: Parameters<JobHandler>[0], deps: ProductIndexingDeps & { scrollSize?: number }) => Promise<void>;

// Enqueues go through the worker's runtime; the processor runs the job under the query cache.
function productJob(min: number, max: number, body: Body) {
  return (overrides: Partial<ProductIndexingDeps & { scrollSize: number }> = {}): JobHandler => {
    const deps = { ...defaultProductIndexingDeps, ...overrides };
    return async (args, context) => {
      checkArity(args, min, max);
      await withJobsRuntime(context.runtime, () => body(args, deps));
    };
  };
}

export const sendToElasticsearchWorkerWith = productJob(0, Infinity, (args, deps) => sendToElasticsearch(args, deps));
export const refreshProductsRecommendationEligibilityJobWith = productJob(1, 1, ([userId], deps) => refreshProductsRecommendationEligibility(userId, deps));
export const reindexRecommendableProductsWorkerWith = productJob(0, 0, (_args, deps) => reindexRecommendableProducts(deps));

export const sendToElasticsearchWorker = sendToElasticsearchWorkerWith();
export const refreshUserProductsRecommendationEligibilityJob = refreshProductsRecommendationEligibilityJobWith();
export const refreshMerchantAccountProductsRecommendationEligibilityJob = refreshProductsRecommendationEligibilityJobWith();
export const reindexRecommendableProductsWorker = reindexRecommendableProductsWorkerWith();
