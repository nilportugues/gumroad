// Replays activate-integrations-worker.golden.json (scripts/golden/activate-integrations-worker.rb): the job run by the real app as a
// Sidekiq job. Node sends the statements Rails sent for a purchase with no enabled Circle integration (on the first option or on the
// product), and hands back, after the same statements, one with an integration.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { activateIntegrationsWorkerWith } from "./activate-integrations-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/activate-integrations-worker.golden.json", import.meta.url));

// Rails raises for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("ActivateIntegrationsWorker", golden, activateIntegrationsWorkerWith(), (c) => castByRails(c.args[0]));
