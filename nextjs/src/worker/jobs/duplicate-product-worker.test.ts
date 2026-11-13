// Replays duplicate-product-worker.golden.json (scripts/golden/duplicate-product-worker.rb): DuplicateProductWorker run by the real app as a
// Sidekiq job, recorded up to the duplication or the Sentry report of a missing product. Node sends the same product read and hands back.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { duplicateProductWorkerWith } from "./duplicate-product-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/duplicate-product-worker.golden.json", import.meta.url));

// Ids Rails casts other than an Integer or a digit string (nil, a float, a word) are handed back before any statement.
const castByRails = (id: unknown) =>
  !((typeof id === "number" && Number.isInteger(id)) || (typeof id === "string" && /^\d+$/u.test(id)));

replayJobGolden("DuplicateProductWorker", golden, duplicateProductWorkerWith(), (c) => castByRails(c.args[0]));
