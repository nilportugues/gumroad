// Replays retry-pending-mandate-charge-job.golden.json (scripts/golden/retry-pending-mandate-charge-job.rb): RetryPendingMandateChargeJob
// run by the real app as a Sidekiq job. Node sends Rails' statements for an order that does not exist, and hands back one that does.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { retryPendingMandateChargeJobWith } from "./retry-pending-mandate-charge-job.ts";

const golden = loadGolden(new URL("./__fixtures__/retry-pending-mandate-charge-job.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("RetryPendingMandateChargeJob", golden, retryPendingMandateChargeJobWith(), (c) =>
  castByRails(c.args[0]),
);
