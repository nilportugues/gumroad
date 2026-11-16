// Replays refresh-merchant-account-payment-method-availability-worker.golden.json
// (scripts/golden/refresh-merchant-account-payment-method-availability-worker.rb): the job run by the real app as a Sidekiq job with the
// Stripe capabilities service replaced by a recorder. Node reads the account with the same statement and leaves alone every account Rails
// left alone; a Connect account is handed back right after the read, and so are a json_data Ruby fails to dig into and an id Rails
// casts (a float, a word) or reads as no id (nil).
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { refreshMerchantAccountPaymentMethodAvailabilityWorkerWith } from "./refresh-merchant-account-payment-method-availability-worker.ts";

const CAST_IDS = new Set(["an account id of nil", "an account id given as a float", "an account id given as a word"]);
const UNREADABLE_JSON_DATA = new Set([
  "a stripe account with json data that is an array",
  "a stripe account with meta that is a string",
]);

describeGuardedJob({
  title: "RefreshMerchantAccountPaymentMethodAvailabilityWorker",
  file: "refresh-merchant-account-payment-method-availability-worker.golden.json",
  make: (deps) => refreshMerchantAccountPaymentMethodAvailabilityWorkerWith(deps),
  reached: (c) => (c.processed as number[]).length > 0 || UNREADABLE_JSON_DATA.has(c.name),
  castBefore: (c) => CAST_IDS.has(c.name),
});
