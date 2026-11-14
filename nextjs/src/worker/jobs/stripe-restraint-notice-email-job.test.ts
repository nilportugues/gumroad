// Replays stripe-restraint-notice-email-job.golden.json (scripts/golden/stripe-restraint-notice-email-job.rb): the job run by the real app
// as a Sidekiq job. Node sends the one `users` read Rails sent (and raises RecordNotFound for a missing user), then hands back before
// the row lock.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { stripeRestraintNoticeEmailJobWith } from "./stripe-restraint-notice-email-job.ts";

const golden = loadGolden(new URL("./__fixtures__/stripe-restraint-notice-email-job.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "StripeRestraintNoticeEmailJob",
  golden,
  stripeRestraintNoticeEmailJobWith(),
  (c) => c.args.length === 4 && castByRails(c.args[0]),
);
