// Replays finalize-buyer-presentment-purchase-job.golden.json (scripts/golden/finalize-buyer-presentment-purchase-job.rb): the job run by
// the real app as a Sidekiq job. Node sends the one `purchases` read Rails sent, finishes a purchase that is not in progress (and raises
// RecordNotFound for a missing one), and hands an in-progress purchase back before the settlement checks.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { finalizeBuyerPresentmentPurchaseJobWith } from "./finalize-buyer-presentment-purchase-job.ts";

const golden = loadGolden(new URL("./__fixtures__/finalize-buyer-presentment-purchase-job.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "FinalizeBuyerPresentmentPurchaseJob",
  golden,
  finalizeBuyerPresentmentPurchaseJobWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
