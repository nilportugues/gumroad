// Replays annual-payout-export-worker.golden.json (scripts/golden/annual-payout-export-worker.rb): AnnualPayoutExportWorker run by the
// real app as a Sidekiq job. Node sends the `User.find` Rails sent and finishes a seller that does not exist with Rails' error; a seller
// that is found goes back to Rails at the query cap, before the payments scan.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { annualPayoutExportWorkerWith } from "./annual-payout-export-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/annual-payout-export-worker.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "AnnualPayoutExportWorker",
  golden,
  annualPayoutExportWorkerWith(),
  (c) => c.args.length >= 2 && c.args.length <= 3 && castByRails(c.args[0]),
);
