// Replays charge-preorder-worker.golden.json (scripts/golden/charge-preorder-worker.rb): the job run by the real app as a Sidekiq job.
// Node sends the one `preorders` read Rails sent, raises Ruby's NoMethodError for a missing preorder, and hands a preorder back before
// the charge.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { chargePreorderWorkerWith } from "./charge-preorder-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/charge-preorder-worker.golden.json", import.meta.url));

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "ChargePreorderWorker",
  golden,
  chargePreorderWorkerWith(),
  (c) => c.args.length >= 1 && c.args.length <= 2 && castByRails(c.args[0]),
);
