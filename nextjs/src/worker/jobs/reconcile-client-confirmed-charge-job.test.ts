// Replays reconcile-client-confirmed-charge-job.golden.json (scripts/golden/reconcile-client-confirmed-charge-job.rb):
// ReconcileClientConfirmedChargeJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for the three opening
// guards and ends the job where Rails returns; a charge with an in-progress purchase goes back to Rails before the Stripe searches.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { reconcileClientConfirmedChargeJobWith } from "./reconcile-client-confirmed-charge-job.ts";

const golden = loadGolden(new URL("./__fixtures__/reconcile-client-confirmed-charge-job.golden.json", import.meta.url));

// Rails casts a float or a word to an id; Node hands those arguments back instead. nil is its own `IS NULL` statement.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "ReconcileClientConfirmedChargeJob",
  golden,
  reconcileClientConfirmedChargeJobWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
