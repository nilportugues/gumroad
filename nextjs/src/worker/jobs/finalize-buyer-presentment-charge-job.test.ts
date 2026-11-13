// Replays finalize-buyer-presentment-charge-job.golden.json (scripts/golden/finalize-buyer-presentment-charge-job.rb): FinalizeBuyerPresentmentChargeJob
// run by the real app as a Sidekiq job. Node sends Rails' statements for a charge that does not defer settlement, and hands back one that does.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { finalizeBuyerPresentmentChargeJobWith } from "./finalize-buyer-presentment-charge-job.ts";

const golden = loadGolden(new URL("./__fixtures__/finalize-buyer-presentment-charge-job.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("FinalizeBuyerPresentmentChargeJob", golden, finalizeBuyerPresentmentChargeJobWith(), (c) =>
  castByRails(c.args[0]),
);
