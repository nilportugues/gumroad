// Replays generate-subscribe-preview-job.golden.json (scripts/golden/generate-subscribe-preview-job.rb): the job and the block of its
// sidekiq_retries_exhausted run by the real app. Node sends the one `users` read Rails sent and raises Rails' RecordNotFound for a
// missing user; a user that exists hands back before the image is generated, in the job and in the block alike.
import { loadGolden, replayHookGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import {
  generateSubscribePreviewJobRetriesExhaustedWith,
  generateSubscribePreviewJobWith,
} from "./generate-subscribe-preview-job.ts";

const golden = loadGolden(new URL("./__fixtures__/generate-subscribe-preview-job.golden.json", import.meta.url));
const isHook = (c: { name: string }) => c.name.startsWith("exhausted: ");

// Rails reads `id IS NULL` for nil, casts a float and reads NULL for a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));
const handsBackEarly = (c: { args: unknown[] }) => c.args.length === 1 && castByRails(c.args[0]);

replayJobGolden(
  "GenerateSubscribePreviewJob",
  { now: golden.now, cases: golden.cases.filter((c) => !isHook(c)) },
  generateSubscribePreviewJobWith(),
  handsBackEarly,
);

replayHookGolden(
  "GenerateSubscribePreviewJob, sidekiq_retries_exhausted",
  { now: golden.now, cases: golden.cases.filter(isHook) },
  generateSubscribePreviewJobRetriesExhaustedWith(generateSubscribePreviewJobWith()),
  handsBackEarly,
);
