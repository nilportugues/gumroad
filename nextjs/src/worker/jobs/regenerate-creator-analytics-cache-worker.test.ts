// Replays regenerate-creator-analytics-cache-worker.golden.json (scripts/golden/regenerate-creator-analytics-cache-worker.rb): the job run by
// the real app as a Sidekiq job with the analytics caching proxy replaced by a recorder. A seller that does not exist fails with the same
// statement and RecordNotFound; one that does is handed back right after the read (a date Ruby rejects included, since the proxy is Rails'
// either way), and so is an id Rails casts (a float, a word) or reads as no id (nil).
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { regenerateCreatorAnalyticsCacheWorkerWith } from "./regenerate-creator-analytics-cache-worker.ts";

const CAST_IDS = new Set(["a seller id of nil", "a seller id given as a float", "a seller id given as a word"]);
// Rails read the seller, then failed parsing the date.
const BAD_DATES = new Set(["a seller and a date that is not a date", "a seller and a date of nil"]);

describeGuardedJob({
  title: "RegenerateCreatorAnalyticsCacheWorker",
  file: "regenerate-creator-analytics-cache-worker.golden.json",
  make: (deps) => regenerateCreatorAnalyticsCacheWorkerWith(deps),
  reached: (c) => (c.processed as unknown[]).length > 0 || BAD_DATES.has(c.name),
  castBefore: (c) => CAST_IDS.has(c.name),
});
