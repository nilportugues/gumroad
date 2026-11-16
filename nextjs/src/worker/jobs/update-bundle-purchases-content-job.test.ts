// Replays update-bundle-purchases-content-job.golden.json (scripts/golden/update-bundle-purchases-content-job.rb):
// UpdateBundlePurchasesContentJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for every bundle with no
// sale to update, and hands back, after the same statements, a bundle with one.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { updateBundlePurchasesContentJobWith } from "./update-bundle-purchases-content-job.ts";

const golden = loadGolden(new URL("./__fixtures__/update-bundle-purchases-content-job.golden.json", import.meta.url));

// Rails finds nothing for nil; Node hands the argument back instead of reproducing the error.
replayJobGolden(
  "UpdateBundlePurchasesContentJob",
  golden,
  updateBundlePurchasesContentJobWith(),
  (c) => c.args[0] === null,
);
