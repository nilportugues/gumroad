// Replays update-integrations-on-tier-change-worker.golden.json (scripts/golden/update-integrations-on-tier-change-worker.rb): the job
// run by the real app as a Sidekiq job. Node sends the statements Rails sent while the tier change adds or removes nobody, and hands
// back, after the same statements, a Circle member to add or remove or a Discord member to remove.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { updateIntegrationsOnTierChangeWorkerWith } from "./update-integrations-on-tier-change-worker.ts";

const golden = loadGolden(
  new URL("./__fixtures__/update-integrations-on-tier-change-worker.golden.json", import.meta.url),
);

// Rails raises for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("UpdateIntegrationsOnTierChangeWorker", golden, updateIntegrationsOnTierChangeWorkerWith(), (c) =>
  castByRails(c.args[0]),
);
