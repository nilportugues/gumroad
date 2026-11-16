// Replays check-indian-card-mandate-registration-job.golden.json (scripts/golden/check-indian-card-mandate-registration-job.rb): the job
// run by the real app as a Sidekiq job. Node sends the one `purchases` read Rails sent and raises RecordNotFound for a missing purchase;
// an existing one hands back before the feature-flag check, with nothing written.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { checkIndianCardMandateRegistrationJobWith } from "./check-indian-card-mandate-registration-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/check-indian-card-mandate-registration-job.golden.json", import.meta.url),
);

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "CheckIndianCardMandateRegistrationJob",
  golden,
  checkIndianCardMandateRegistrationJobWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
