// Replays deliver-files-ready-notification-job.golden.json (scripts/golden/deliver-files-ready-notification-job.rb): the job run by the
// real app as a Sidekiq job. Node sends the request check and the `purchases` read Rails sent, returns where Rails returns, raises
// Rails' RecordNotFound, and hands a request whose purchase exists back before the stamp check.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { deliverFilesReadyNotificationJobWith } from "./deliver-files-ready-notification-job.ts";

const golden = loadGolden(new URL("./__fixtures__/deliver-files-ready-notification-job.golden.json", import.meta.url));

// Rails casts a float and reads `purchase_id = NULL` for a word; Node hands those arguments back instead. Nil and a blank string
// make the request check return before any statement.
const castByRails = (value: unknown) =>
  value !== null &&
  !(typeof value === "string" && value.trim() === "") &&
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "DeliverFilesReadyNotificationJob",
  golden,
  deliverFilesReadyNotificationJobWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
