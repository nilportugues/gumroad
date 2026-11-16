// Port of the guards of app/sidekiq/handle_sns_mediaconvert_event_worker.rb: anything but a Notification, and an event for a job no
// processing TranscodedVideo carries (a repeated event for a finished job), is dropped. An event for a job in flight goes to
// TranscodeEventHandler#handle_transcoding_job_notification (the video updates and their streamables), which stays with Rails: the job is
// handed back right after the lookup, before anything is written. A message Ruby fails to read or reads loosely (not JSON, no `detail`
// hash, a job id that is not a string) hands back before any statement.
// Golden: __fixtures__/handle-sns-mediaconvert-event-worker.golden.json (scripts/golden/handle-sns-mediaconvert-event-worker.rb); the
// handler was replaced by a recorder there.
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const TRANSCODED_VIDEOS = "transcoded_videos";

const isHash = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const handleSnsMediaconvertEventWorkerWith = modelJob({ min: 1 }, async ([notification]) => {
  if (!isHash(notification)) throw new HandBackToRuby("the notification is not a hash");
  if (notification.Type !== "Notification") return;

  if (typeof notification.Message !== "string") throw new HandBackToRuby("the message is not a string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(notification.Message);
  } catch {
    throw new HandBackToRuby("the message is not JSON");
  }
  const detail = isHash(parsed) ? parsed.detail : undefined;
  if (!isHash(detail)) throw new HandBackToRuby("the message has no detail hash");
  const jobId = detail.jobId;
  if (typeof jobId !== "string") throw new HandBackToRuby("jobId is not a string");

  // `TranscodedVideo.processing.exists?(job_id:)`
  const rows = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(TRANSCODED_VIDEOS)} WHERE ${column(TRANSCODED_VIDEOS, "state")} = 'processing' AND ${column(TRANSCODED_VIDEOS, "job_id")} = ${jobId} LIMIT 1`,
  );
  if (rows.length === 0) return;

  throw new HandBackToRuby("TranscodeEventHandler#handle_transcoding_job_notification is not ported");
});

export const handleSnsMediaconvertEventWorker = handleSnsMediaconvertEventWorkerWith();
