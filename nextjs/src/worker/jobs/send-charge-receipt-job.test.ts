// Replays send-charge-receipt-job.golden.json (scripts/golden/send-charge-receipt-job.rb): SendChargeReceiptJob
// run by the real app as a Sidekiq job. Node sends Rails' statements for a charge whose receipt is sent, and hands back one that is not.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sendChargeReceiptJobWith } from "./send-charge-receipt-job.ts";

const golden = loadGolden(new URL("./__fixtures__/send-charge-receipt-job.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("SendChargeReceiptJob", golden, sendChargeReceiptJobWith(), (c) => castByRails(c.args[0]));
