// Replays generate-large-sellers-analytics-cache-worker.golden.json (scripts/golden/generate-large-sellers-analytics-cache-worker.rb):
// the job run by the real app as a Sidekiq job. Node sends the one join Rails sent and finishes when no user is a large seller, and
// hands back, after that scan, the first large seller.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { generateLargeSellersAnalyticsCacheWorkerWith } from "./generate-large-sellers-analytics-cache-worker.ts";

const golden = loadGolden(
  new URL("./__fixtures__/generate-large-sellers-analytics-cache-worker.golden.json", import.meta.url),
);

replayJobGolden("GenerateLargeSellersAnalyticsCacheWorker", golden, generateLargeSellersAnalyticsCacheWorkerWith());
