// Replays the ReindexSubscriptionCurrentEmailWorker and BackfillMerchantAccountRecommendationEligibilityJob
// cases of search.golden.json. The refresh job's enqueues take unique-jobs locks, so those cases
// need JOBS_REDIS_URL=redis://127.0.0.1:6379/12 npm test.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { replayJobCase, rubyRegistry } from "../../server/search/__fixtures__/job-harness.ts";
import { searchGolden, type SearchCase } from "../../server/search/__fixtures__/search-golden.ts";
import { snapshotRedis } from "./__fixtures__/golden.ts";
import { backfillMerchantAccountRecommendationEligibilityJob, reindexSubscriptionCurrentEmailWorker } from "./search-reindex-jobs.ts";
import type { JobHandler } from "./types.ts";

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

const takesLocks = (c: SearchCase) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));
const registry = rubyRegistry("ElasticsearchIndexerWorker", "RefreshMerchantAccountProductsRecommendationEligibilityJob");

const PORTS: Record<string, JobHandler> = {
  ReindexSubscriptionCurrentEmailWorker: reindexSubscriptionCurrentEmailWorker,
  BackfillMerchantAccountRecommendationEligibilityJob: backfillMerchantAccountRecommendationEligibilityJob,
};

for (const [name, handler] of Object.entries(PORTS)) {
  describe(name, () => {
    for (const golden of searchGolden.jobs[name]!) {
      it.skipIf(takesLocks(golden) && !url)(golden.name, async () => {
        let redis;
        if (takesLocks(golden)) {
          await realRedis!.flushdb();
          redis = { redis: realRedis!, snapshot: () => snapshotRedis(realRedis!) };
        }
        // JSON::ParserError's message is the Ruby parser's own wording; only the class is ported.
        const expected = golden.error?.class === "JSON::ParserError" ? { ...golden, error: { class: golden.error.class, message: expect.any(String) as unknown as string } } : golden;
        await replayJobCase(expected, handler, { registry, ...(redis ? { redis } : {}) });
      });
    }
  });
}
