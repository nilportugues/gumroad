// Replays refund-purchase-for-fraud-worker.golden.json (scripts/golden/refund-purchase-for-fraud-worker.rb): RefundPurchaseForFraudWorker
// run by the real app as a Sidekiq job. Node sends the `Purchase.find` Rails sent and hands every purchase back to Rails, found (the
// refund) or missing (the ErrorNotifier report); an id Rails casts goes back before any read.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { refundPurchaseForFraudWorkerWith } from "./refund-purchase-for-fraud-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/refund-purchase-for-fraud-worker.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "RefundPurchaseForFraudWorker",
  golden,
  refundPurchaseForFraudWorkerWith(),
  (c) => c.args.length >= 2 && c.args.length <= 3 && castByRails(c.args[0]),
);
