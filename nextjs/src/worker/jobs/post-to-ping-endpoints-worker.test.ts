// Replays post-to-ping-endpoints-worker.golden.json (scripts/golden/post-to-ping-endpoints-worker.rb): PostToPingEndpointsWorker run by the
// real app as a Sidekiq job. Node sends the `Subscription.find` or `Purchase.find` Rails sent, finishes the two early returns and a record
// that is missing with Rails' error, and hands a record that is found back to Rails before the ping payload.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { postToPingEndpointsWorkerWith } from "./post-to-ping-endpoints-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/post-to-ping-endpoints-worker.golden.json", import.meta.url));

const isId = (value: unknown) =>
  (typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

// Rails casts a float or a word to an id; Node hands those arguments back instead. A purchase id of nil is Rails' own error.
const castByRails = (args: unknown[]) => {
  const subscriptionId = args[3];
  if (subscriptionId === undefined || subscriptionId === null || subscriptionId === false || subscriptionId === "")
    return args[0] !== null && !isId(args[0]);
  return !isId(subscriptionId);
};

replayJobGolden(
  "PostToPingEndpointsWorker",
  golden,
  postToPingEndpointsWorkerWith(),
  (c) => c.args.length >= 2 && c.args.length <= 5 && castByRails(c.args),
);
