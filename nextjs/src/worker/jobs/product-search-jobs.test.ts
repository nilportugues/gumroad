// Replays the job cases of product-search.golden.json (generate-product-search-golden.rb) against a
// real Redis, since every case touches Sidekiq's: JOBS_REDIS_URL=redis://127.0.0.1:6379/13 npm test.
// The database is flushed between cases.
import { Redis } from "ioredis";
import { afterAll, describe, it } from "vitest";

import { productGolden, replayProductCase } from "../../server/search/__fixtures__/product-search-golden.ts";
import { enqueueIndexUpdatesFor, refreshProductsRecommendationEligibility, reindexRecommendableProducts, sendToElasticsearch } from "../../server/search/product-indexing.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");

describe.skipIf(!url)("product indexing jobs", () => {
  const redis = new Redis(url ?? "", { maxRetriesPerRequest: null, lazyConnect: true });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  const bodies: Record<string, (args: JsonValue[], deps: Parameters<typeof sendToElasticsearch>[1]) => Promise<void>> = {
    SendToElasticsearchWorker: (args, deps) => sendToElasticsearch(args, deps),
    RefreshUserProductsRecommendationEligibilityJob: ([userId], deps) => refreshProductsRecommendationEligibility(userId, deps),
    RefreshMerchantAccountProductsRecommendationEligibilityJob: ([userId], deps) => refreshProductsRecommendationEligibility(userId, deps),
    ReindexRecommendableProductsWorker: (_args, deps) => reindexRecommendableProducts({ ...deps, scrollSize: productGolden.reindex_scroll_size }),
  };

  for (const [job, body] of Object.entries(bodies)) {
    describe(job, () => {
      for (const c of productGolden.jobs[job]!) {
        it(c.name, () => replayProductCase(c, redis, (deps) => body(c.args, deps)));
      }
    });
  }

  // User#update_product_search_index!: Ruby's first three statements are the transaction around
  // find_each, which in Node is the caller's; the ids come from that batch.
  describe("Link#enqueue_index_update_for after a User save", () => {
    for (const c of productGolden.user_product_index_updates) {
      it(c.name, () => {
        const [, batch] = c.statements;
        const idColumn = batch!.result!.fields!.indexOf("id");
        const ids = batch!.result!.rows!.map((row) => BigInt(row[idColumn] as number));
        return replayProductCase(c, redis, (deps) => enqueueIndexUpdatesFor(ids, c.args[1] as string[], deps), { statements: c.statements.slice(3) });
      });
    }
  });
});
