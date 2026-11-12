// Replays pdf-unstampable-notifier-job.golden.json (scripts/golden/pdf-unstampable-notifier-job.rb): PdfUnstampableNotifierJob run by the
// real app as a Sidekiq job. Node sends the statements Rails sent for a product with no PDF left to check, and hands back, after the
// same statements, a product with one.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { pdfUnstampableNotifierJobWith } from "./pdf-unstampable-notifier-job.ts";

const golden = loadGolden(new URL("./__fixtures__/pdf-unstampable-notifier-job.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) && !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("PdfUnstampableNotifierJob", golden, pdfUnstampableNotifierJobWith(), (c) => castByRails(c.args[0]));
