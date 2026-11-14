// Port of app/sidekiq/transcode_video_for_streaming_worker.rb up to `attempt_to_transcode?`. A Link is no longer transcoded and ends the
// job before any read; a ProductFile is found in Node and a deleted one ends the job. Anything after that reads `transcoded_videos`, then
// creates the TranscodedVideo and calls MediaConvert or GRMC, so a live file goes back to Rails before it. A class other than the two, and
// an id Rails casts, go back before any read.
// Golden: __fixtures__/transcode-video-for-streaming-worker.golden.json (scripts/golden/transcode-video-for-streaming-worker.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

export const transcodeVideoForStreamingWorkerWith = modelJob(
  { min: 1, max: 4 },
  async ([id, klassName = "ProductFile"]) => {
    if (klassName === "Link") return;

    const fileId = await beforeSideEffects(() => {
      if (klassName !== "ProductFile")
        throw new NotPortedError("klass_name.constantize.find", "only ProductFile is read in Node");
      return recordIdFrom(id, "ProductFile.find");
    });
    const file = await findByIdBang<{ deleted_at: Date | null }>("ProductFile", fileId);
    if (file.deleted_at !== null) return;

    throw new HandBackToRuby("the video is checked for a transcode and sent to the transcoder");
  },
);
export const transcodeVideoForStreamingWorker = transcodeVideoForStreamingWorkerWith();
