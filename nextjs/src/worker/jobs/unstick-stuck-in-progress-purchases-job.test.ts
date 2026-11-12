// Replays unstick-stuck-in-progress-purchases-job.golden.json (scripts/golden/unstick-stuck-in-progress-purchases-job.rb):
// UnstickStuckInProgressPurchasesJob run by the real app as a Sidekiq job. Node sends the statements Rails sent for a run with nothing
// stuck, and hands back, after the same statements, a run with a purchase to recover or one aged out of the window.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { unstickStuckInProgressPurchasesJobWith } from "./unstick-stuck-in-progress-purchases-job.ts";

const golden = loadGolden(new URL("./__fixtures__/unstick-stuck-in-progress-purchases-job.golden.json", import.meta.url));

// Ids Rails casts (nil, a float, a word, digit strings, a single id) are handed back before any statement.
const castByRails = (ids: unknown) =>
  ids !== null && (!Array.isArray(ids) || ids.some((id) => !(typeof id === "number" && Number.isInteger(id))));

replayJobGolden(
  "UnstickStuckInProgressPurchasesJob",
  golden,
  unstickStuckInProgressPurchasesJobWith({ now: () => new Date(Math.round(golden.now * 1000)) }),
  (c) => castByRails(c.args[0] ?? null),
);
