// Replays send-workflow-emails-to-opened-non-clickers-job.golden.json (scripts/golden/send-workflow-emails-to-opened-non-clickers-job.rb):
// the job run by the real app as a Sidekiq job. Node sends the installment and workflow reads Rails sent and finishes every run a guard
// ends; a run that passes them hands back before the trigger post is resolved, with nothing written.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sendWorkflowEmailsToOpenedNonClickersJobWith } from "./send-workflow-emails-to-opened-non-clickers-job.ts";

const golden = loadGolden(
  new URL("./__fixtures__/send-workflow-emails-to-opened-non-clickers-job.golden.json", import.meta.url),
);

// Rails casts a float or a word and Node hands those back; a minimum rule version that is text or a list is read by Rails.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const unreadVersion = (value: unknown) => typeof value === "string" || Array.isArray(value);

replayJobGolden(
  "SendWorkflowEmailsToOpenedNonClickersJob",
  golden,
  sendWorkflowEmailsToOpenedNonClickersJobWith(),
  (c) =>
    c.args.length >= 1 &&
    c.args.length <= 4 &&
    ((c.args[0] !== null && castByRails(c.args[0])) || unreadVersion(c.args[3])),
);
