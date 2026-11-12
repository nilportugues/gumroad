// Replays push-notification-worker.golden.json (scripts/golden/push-notification-worker.rb): the job run by the real app as a Sidekiq
// job. Node sends the `users` and `devices` reads Rails sent and finishes when no iOS or Android device is left to push to; the first
// one is handed back before the push.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { pushNotificationWorkerWith } from "./push-notification-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/push-notification-worker.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead, as it does an
// app type that is not a string and any push to the team admins.
const handsBackEarly = (c: { args: unknown[] }) => {
  if (c.args.length < 3 || c.args.length > 7) return false;
  const [receiverId, appType] = c.args;
  const castByRails =
    !(typeof receiverId === "number" && Number.isInteger(receiverId)) &&
    !(typeof receiverId === "string" && /^[0-9]{1,15}$/u.test(receiverId));
  const toTeamAdmins = c.args[6];
  return (
    castByRails ||
    typeof appType !== "string" ||
    (toTeamAdmins !== undefined && toTeamAdmins !== null && toTeamAdmins !== false)
  );
};

replayJobGolden("PushNotificationWorker", golden, pushNotificationWorkerWith(), handsBackEarly);
