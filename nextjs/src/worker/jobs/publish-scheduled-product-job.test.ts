// Replays publish-scheduled-product-job.golden.json (scripts/golden/publish-scheduled-product-job.rb): the job run by the real app as
// a Sidekiq job. Node sends the `find_by(id:)` Rails sent and finishes a schedule that does not exist; a schedule that is found goes back
// to Rails before `run!` claims it.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { publishScheduledProductJobWith } from "./publish-scheduled-product-job.ts";

const golden = loadGolden(new URL("./__fixtures__/publish-scheduled-product-job.golden.json", import.meta.url));

// Rails casts a float, a word, nil, true and an array to an id of its own; Node hands those arguments back before any read.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden(
  "PublishScheduledProductJob",
  golden,
  publishScheduledProductJobWith(),
  (c) => c.args.length === 1 && castByRails(c.args[0]),
);
