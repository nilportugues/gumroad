// Replays schedule-membership-price-updates-job.golden.json (scripts/golden/schedule-membership-price-updates-job.rb):
// ScheduleMembershipPriceUpdatesJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for every run that ends
// before a subscription, and hands back, after the same statements, a run that reaches one.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { scheduleMembershipPriceUpdatesJobWith } from "./schedule-membership-price-updates-job.ts";

const golden = loadGolden(new URL("./__fixtures__/schedule-membership-price-updates-job.golden.json", import.meta.url));

// Rails casts a Float or finds nothing for nil; Node does not reproduce either.
replayJobGolden(
  "ScheduleMembershipPriceUpdatesJob",
  golden,
  scheduleMembershipPriceUpdatesJobWith(),
  (c) => typeof c.args[0] !== "string" && !Number.isInteger(c.args[0]),
);
