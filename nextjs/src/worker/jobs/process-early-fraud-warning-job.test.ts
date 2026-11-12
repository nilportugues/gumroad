// Replays process-early-fraud-warning-job.golden.json (scripts/golden/process-early-fraud-warning-job.rb): the job run by the real app
// as a Sidekiq job. Node sends the one read Rails sent for a missing or resolved warning (and raises RecordNotFound for a missing
// one), and hands an unresolved warning back before the Stripe refresh.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { processEarlyFraudWarningJobWith } from "./process-early-fraud-warning-job.ts";

const golden = loadGolden(new URL("./__fixtures__/process-early-fraud-warning-job.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("ProcessEarlyFraudWarningJob", golden, processEarlyFraudWarningJobWith(), (c) =>
  castByRails(c.args[0]),
);
