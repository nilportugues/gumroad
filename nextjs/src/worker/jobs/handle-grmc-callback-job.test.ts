// Replays handle-grmc-callback-job.golden.json (scripts/golden/handle-grmc-callback-job.rb): the job run by the real app as a Sidekiq job
// with the sweep over a source file's processing videos replaced by a recorder. Node drops a notification no processing video carries with
// the same lookup; one that does is handed back right after it, and so is a notification Ruby reads in a way Node does not.
import { describeGuardedJob } from "./__fixtures__/guard-golden.ts";
import { handleGrmcCallbackJobWith } from "./handle-grmc-callback-job.ts";

const UNREAD = new Set([
  "a job id given as an integer",
  "a job id given as an array",
  "a notification that is a string",
  "a notification that is nil",
  "a notification that is an array",
]);

describeGuardedJob({
  title: "HandleGrmcCallbackJob",
  file: "handle-grmc-callback-job.golden.json",
  make: (deps) => handleGrmcCallbackJobWith(deps),
  reached: (c) => (c.processed as string[]).length > 0,
  castBefore: (c) => UNREAD.has(c.name),
});
