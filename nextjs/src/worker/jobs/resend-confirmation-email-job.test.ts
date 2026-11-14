// Replays resend-confirmation-email-job.golden.json (scripts/golden/resend-confirmation-email-job.rb): ResendConfirmationEmailJob run by
// the real app as a Sidekiq job. Node sends the user lookup Rails sent and finishes a user who is gone, deleted or has nothing left to
// confirm; a user with something to confirm hands back after the same lookup.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { resendConfirmationEmailJobWith } from "./resend-confirmation-email-job.ts";

const golden = loadGolden(new URL("./__fixtures__/resend-confirmation-email-job.golden.json", import.meta.url));

// Rails casts a Float, a word to NULL and nil to IS NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("ResendConfirmationEmailJob", golden, resendConfirmationEmailJobWith(), (c) => castByRails(c.args[0]));
