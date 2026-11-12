// Replays create-stripe-merchant-account-worker.golden.json (scripts/golden/create-stripe-merchant-account-worker.rb): the job run by the
// real app as a Sidekiq job. Node sends the one `users` read Rails sent (and raises RecordNotFound for a missing user), then hands back
// before the Stripe account is created.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { createStripeMerchantAccountWorkerWith } from "./create-stripe-merchant-account-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/create-stripe-merchant-account-worker.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("CreateStripeMerchantAccountWorker", golden, createStripeMerchantAccountWorkerWith(), (c) =>
  castByRails(c.args[0]),
);
