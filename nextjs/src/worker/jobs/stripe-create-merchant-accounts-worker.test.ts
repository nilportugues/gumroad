// Replays stripe-create-merchant-accounts-worker.golden.json (scripts/golden/stripe-create-merchant-accounts-worker.rb):
// StripeCreateMerchantAccountsWorker run by the real app as a Sidekiq job. Node sends the discovery statement with the same
// cutoff, reads the sellers and each one's compliance revision the way Rails does, and pushes the same per-seller jobs.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { stripeCreateMerchantAccountsWorkerWith } from "./stripe-create-merchant-accounts-worker.ts";

const golden = loadGolden(
  new URL("./__fixtures__/stripe-create-merchant-accounts-worker.golden.json", import.meta.url),
);

replayJobGolden(
  "StripeCreateMerchantAccountsWorker",
  golden,
  stripeCreateMerchantAccountsWorkerWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
);
