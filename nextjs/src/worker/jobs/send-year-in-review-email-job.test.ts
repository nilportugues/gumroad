// Replays send-year-in-review-email-job.golden.json (scripts/golden/send-year-in-review-email-job.rb): the job run by the real app as a
// Sidekiq job. Node sends the seller read and the annual report reads Rails sent and finishes a seller with no report for the year; a
// seller with one hands back before the report's URL is built, with nothing written.
import { RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";

import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { sendYearInReviewEmailJobWith } from "./send-year-in-review-email-job.ts";

const golden = loadGolden(new URL("./__fixtures__/send-year-in-review-email-job.golden.json", import.meta.url));

// Rails raises for a nil id and casts a Float or a word; Node hands those arguments back. So it does a year that is not an Integer
// from 0 to 10000.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const unreadYear = (value: unknown) =>
  value instanceof RubyFloat || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000;

replayJobGolden(
  "SendYearInReviewEmailJob",
  golden,
  sendYearInReviewEmailJobWith(),
  (c) => c.args.length >= 2 && c.args.length <= 3 && (castByRails(c.args[0]) || unreadYear(c.args[1])),
);
