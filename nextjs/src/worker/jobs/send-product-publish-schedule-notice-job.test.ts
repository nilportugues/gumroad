// Replays send-product-publish-schedule-notice-job.golden.json (scripts/golden/send-product-publish-schedule-notice-job.rb): the job run by the real app as
// a Sidekiq job. Node sends the `notice_unsent.find_by(id:)` Rails sent and finishes a schedule that is missing or already noticed; a schedule
// whose notice is unsent goes back to Rails before the mail.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sendProductPublishScheduleNoticeJobWith } from "./send-product-publish-schedule-notice-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/send-product-publish-schedule-notice-job.golden.json", import.meta.url),
);

// Rails casts a float, a word, nil, true and an array to an id of its own; Node hands those arguments back before any read.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "SendProductPublishScheduleNoticeJob",
  golden,
  sendProductPublishScheduleNoticeJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);
