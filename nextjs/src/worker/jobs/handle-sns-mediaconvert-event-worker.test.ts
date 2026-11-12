// Replays handle-sns-mediaconvert-event-worker.golden.json (scripts/golden/handle-sns-mediaconvert-event-worker.rb): the job run by the
// real app as a Sidekiq job with the transcode handler replaced by a recorder. Node drops what Rails drops with the same statement; an
// event for a job in flight is handed back right after it (a status or path Ruby fails on included: the handler is Rails' either way),
// and so is a message Ruby fails to read or reads loosely.
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { handleSnsMediaconvertEventWorkerWith } from "./handle-sns-mediaconvert-event-worker.ts";

const UNREAD = new Set([
  "a job id of nil",
  "a job id missing",
  "a job id given as an integer",
  "a message that is not json",
  "a message without detail",
  "a message whose detail is a string",
  "a message that is nil",
  "a message that is a json array",
  "a notification that is nil",
  "a notification that is a string",
]);
// Rails reached the lookup and found a video in flight, then failed reading the event before the handler.
const FAILED_AFTER_LOOKUP = new Set([
  "a completed event with a path that is a number",
  "a completed event whose output groups are not an array",
]);

describeGuardedJob({
  title: "HandleSnsMediaconvertEventWorker",
  file: "handle-sns-mediaconvert-event-worker.golden.json",
  make: (deps) => handleSnsMediaconvertEventWorkerWith(deps),
  reached: (c) => (c.processed as unknown[]).length > 0 || FAILED_AFTER_LOOKUP.has(c.name),
  castBefore: (c) => UNREAD.has(c.name),
});
