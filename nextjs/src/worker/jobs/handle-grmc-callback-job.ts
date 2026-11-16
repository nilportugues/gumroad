// Port of the guard of app/sidekiq/handle_grmc_callback_job.rb: a notification whose job no processing TranscodedVideo carries is
// dropped. When one does, Rails sweeps every processing video of that source file (completes them and updates their streamable, or marks
// them failed and re-enqueues a transcode), which stays with Rails: the job is handed back right after the lookup, before anything is
// written. A notification that is not a hash, or whose job_id is not a string or missing, hands back before any statement.
// Golden: __fixtures__/handle-grmc-callback-job.golden.json (scripts/golden/handle-grmc-callback-job.rb); the sweep was replaced by a
// recorder there.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const TRANSCODED_VIDEOS = "transcoded_videos";
// TranscodedVideo's columns, in schema order (product_file_id is an ignored column).
const COLUMNS = [
  "id",
  "link_id",
  "original_video_key",
  "transcoded_video_key",
  "job_id",
  "state",
  "created_at",
  "updated_at",
  "flags",
  "deleted_from_cdn_at",
  "deleted_at",
  "last_accessed_at",
  "streamable_type",
  "streamable_id",
];
export const TRANSCODED_VIDEO_SELECT = Prisma.raw(
  COLUMNS.map((name) => `\`${TRANSCODED_VIDEOS}\`.\`${name}\``).join(", "),
);

// `TranscodedVideo.processing.find_by(job_id:)`
export async function findProcessingTranscodedVideoByJobId(jobId: string | null): Promise<boolean> {
  const condition =
    jobId === null
      ? Prisma.sql`${column(TRANSCODED_VIDEOS, "job_id")} IS NULL`
      : Prisma.sql`${column(TRANSCODED_VIDEOS, "job_id")} = ${jobId}`;
  const rows = await selectRows(
    Prisma.sql`SELECT ${TRANSCODED_VIDEO_SELECT} FROM ${table(TRANSCODED_VIDEOS)} WHERE ${column(TRANSCODED_VIDEOS, "state")} = 'processing' AND ${condition} LIMIT 1`,
  );
  return rows.length > 0;
}

export const handleGrmcCallbackJobWith = modelJob({ min: 1 }, async ([notification]) => {
  if (typeof notification !== "object" || notification === null || Array.isArray(notification))
    throw new HandBackToRuby("the notification is not a hash");
  const jobId = (notification as Record<string, unknown>).job_id ?? null;
  if (jobId !== null && typeof jobId !== "string") throw new HandBackToRuby("job_id is not a string");

  if (!(await findProcessingTranscodedVideoByJobId(jobId))) return;

  throw new HandBackToRuby("the sweep over the processing videos of the source file is not ported");
});

export const handleGrmcCallbackJob = handleGrmcCallbackJobWith();
