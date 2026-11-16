// Replays send-post-blast-emails-job.golden.json (scripts/golden/send-post-blast-emails-job.rb): SendPostBlastEmailsJob run by the real app
// as a Sidekiq job. Node sends the statements Rails sent for the blast and its post, ends the job where a guard returns, and hands a
// sendable blast back to Rails before `started_at` is written.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sendPostBlastEmailsJobWith } from "./send-post-blast-emails-job.ts";

const golden = loadGolden(new URL("./__fixtures__/send-post-blast-emails-job.golden.json", import.meta.url));

// Rails casts a float or a word to an id; Node hands those arguments back instead. nil is Rails' own error.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "SendPostBlastEmailsJob",
  golden,
  sendPostBlastEmailsJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);
