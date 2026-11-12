// Replays attach-past-purchases-to-user-worker.golden.json (scripts/golden/attach-past-purchases-to-user-worker.rb): the job run by the
// real app as a Sidekiq job. Node sends the `users` read and the `find_each` batch Rails sent, finishes when the email is blank or no
// past purchase is left, and hands the first purchase to attach back before any write.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { attachPastPurchasesToUserWorkerWith } from "./attach-past-purchases-to-user-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/attach-past-purchases-to-user-worker.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead, as it does an email that is not a string.
const handsBackEarly = (c: { args: unknown[] }) => {
  if (c.args.length < 1 || c.args.length > 2) return false;
  const [userId, email] = c.args;
  const castByRails =
    !(typeof userId === "number" && Number.isInteger(userId)) && !(typeof userId === "string" && /^[0-9]{1,15}$/u.test(userId));
  return castByRails || !(email === undefined || email === null || typeof email === "string");
};

replayJobGolden("AttachPastPurchasesToUserWorker", golden, attachPastPurchasesToUserWorkerWith(), handsBackEarly);
