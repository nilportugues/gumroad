// Replays handle-new-user-compliance-info-worker.golden.json (scripts/golden/handle-new-user-compliance-info-worker.rb): the job run by the
// real app as a Sidekiq job with the Stripe account manager replaced by a recorder. A compliance info that does not exist fails with the same
// statement and RecordNotFound; one that does is handed back right after the read, and so is an id Rails casts (a float, a word) or reads as
// no id (nil).
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { handleNewUserComplianceInfoWorkerWith } from "./handle-new-user-compliance-info-worker.ts";

const CAST_IDS = new Set([
  "a compliance info id of nil",
  "a compliance info id given as a float",
  "a compliance info id given as a word",
]);

describeGuardedJob({
  title: "HandleNewUserComplianceInfoWorker",
  file: "handle-new-user-compliance-info-worker.golden.json",
  make: (deps) => handleNewUserComplianceInfoWorkerWith(deps),
  reached: (c) => (c.processed as number[]).length > 0,
  castBefore: (c) => CAST_IDS.has(c.name),
});
