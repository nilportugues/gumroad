// Replays collect-unclaimed-balances-of-inactive-stripe-accounts-job.golden.json
// (scripts/golden/collect-unclaimed-balances-of-inactive-stripe-accounts-job.rb): the job run by the real app as a Sidekiq job. Node sends
// the merchant account scan Rails sent, with the three-year cutoff taken from the frozen clock, and finishes an empty scan; a scan that
// returns an account goes back to Rails before that account's reads.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { collectUnclaimedBalancesOfInactiveStripeAccountsJobWith } from "./collect-unclaimed-balances-of-inactive-stripe-accounts-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/collect-unclaimed-balances-of-inactive-stripe-accounts-job.golden.json", import.meta.url),
);

replayJobGolden(
  "CollectUnclaimedBalancesOfInactiveStripeAccountsJob",
  golden,
  collectUnclaimedBalancesOfInactiveStripeAccountsJobWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
);
