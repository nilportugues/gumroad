// Replays deactivate-integrations-worker.golden.json (scripts/golden/deactivate-integrations-worker.rb): the job run by the real app as a
// Sidekiq job. Node sends the statements Rails sent while every purchase of the subscription has nothing to deactivate, and hands back,
// after the same statements, the first Circle integration or Discord member that Rails would remove.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { deactivateIntegrationsWorkerWith } from "./deactivate-integrations-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/deactivate-integrations-worker.golden.json", import.meta.url));

// Rails raises for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("DeactivateIntegrationsWorker", golden, deactivateIntegrationsWorkerWith(), (c) =>
  castByRails(c.args[0]),
);
