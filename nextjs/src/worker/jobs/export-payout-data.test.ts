// Replays export-payout-data.golden.json (scripts/golden/export-payout-data.rb): ExportPayoutData run by the real app as a Sidekiq job.
// Node sends the payments read Rails sent and finishes a job that finds none; a payment that is found goes back to Rails, which builds
// the CSV and mails it.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { exportPayoutDataWith } from "./export-payout-data.ts";

const golden = loadGolden(new URL("./__fixtures__/export-payout-data.golden.json", import.meta.url));

// Rails casts a word to NULL; Node hands those ids back instead of reproducing the cast.
const castByRails = (id: unknown) =>
  !(typeof id === "number" && Number.isInteger(id)) && !(typeof id === "string" && /^[0-9]{1,15}$/u.test(id));

replayJobGolden("ExportPayoutData", golden, exportPayoutDataWith(), (c) => {
  if (c.args.length !== 2) return false;
  const ids = c.args[0];
  return (Array.isArray(ids) ? ids : ids === null ? [] : [ids]).some(castByRails);
});
