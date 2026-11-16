// Replays transcode-video-for-streaming-worker.golden.json (scripts/golden/transcode-video-for-streaming-worker.rb): the job run by the
// real app as a Sidekiq job. Node sends the `ProductFile.find` Rails sent, ends a Link, a deleted file and a missing record as Rails did,
// and hands a live file back at `attempt_to_transcode?`.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { transcodeVideoForStreamingWorkerWith } from "./transcode-video-for-streaming-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/transcode-video-for-streaming-worker.golden.json", import.meta.url));

// Rails finds nothing for nil and casts a word to NULL; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

// A Link ends the job before the id is read; any class but ProductFile is constantized and found by Rails.
replayJobGolden(
  "TranscodeVideoForStreamingWorker",
  golden,
  transcodeVideoForStreamingWorkerWith(),
  (c) =>
    c.args.length >= 1 &&
    c.args.length <= 4 &&
    c.args[1] !== "Link" &&
    (castByRails(c.args[0]) || (c.args[1] !== undefined && c.args[1] !== "ProductFile")),
);
