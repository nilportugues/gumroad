// Replays stamp-pdf-for-purchase-job.golden.json (scripts/golden/stamp-pdf-for-purchase-job.rb): the job run by the real app as a
// Sidekiq job. Node sends the one `purchases` read Rails sent, raises Rails' RecordNotFound for a missing purchase and hands a purchase
// back before the stamping.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { stampPdfForPurchaseJobWith } from "./stamp-pdf-for-purchase-job.ts";

const golden = loadGolden(new URL("./__fixtures__/stamp-pdf-for-purchase-job.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "StampPdfForPurchaseJob",
  golden,
  stampPdfForPurchaseJobWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
