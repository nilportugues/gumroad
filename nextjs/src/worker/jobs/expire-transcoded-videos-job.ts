// Port of app/sidekiq/expire_transcoded_videos_job.rb: the Redis limit, the replica lag check, the batch query and
// TranscodedVideo#mark_deleted! (a validated save with a PaperTrail version). A video with a streamable file is handed back to
// Rails before it is written, because mark_deleted! then reads the file and may clear its is_transcoded_for_hls flag through
// ProductFile#update!, which is not ported; the videos before it in the batch are already expired and Rails resumes with the rest.
// Golden: __fixtures__/expire-transcoded-videos-job.golden.json (scripts/golden/expire-transcoded-videos-job.rb).
import { Prisma, type TranscodedVideo } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { rubyStringToBigInt } from "../../server/models/concerns/ruby-numeric.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { TranscodedVideoDeletable, TranscodedVideos } from "../../server/models/transcoded-video.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const TRANSCODED_VIDEOS = "transcoded_videos";
const RECENTNESS_LIMIT_KEY = "transcoded_videos_recentness_limit_in_months";
const BATCH_SIZE = 100;
const DEFAULT_RECENTNESS_LIMIT_IN_MONTHS = 12 * 100;
// Past these Ruby's month arithmetic leaves the years MySQL's DATETIME and its quoting agree on.
const MAX_SUPPORTED_MONTHS = 12 * 1000;

// TranscodedVideo's columns in schema order, minus the ignored product_file_id.
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

export type ExpireTranscodedVideosDeps = { redis: () => Pick<Redis, "get"> };

async function recentnessLimitInMonths(redis: Pick<Redis, "get">): Promise<number> {
  const stored = await redis.get(RECENTNESS_LIMIT_KEY);
  if (stored === null) return DEFAULT_RECENTNESS_LIMIT_IN_MONTHS;
  const months = rubyStringToBigInt(stored);
  if (months > BigInt(MAX_SUPPORTED_MONTHS) || months < -BigInt(MAX_SUPPORTED_MONTHS)) {
    throw new NotPortedError("recentness limit", "expire_transcoded_videos_job.rb");
  }
  return Number(months);
}

export const expireTranscodedVideosJobWith = (
  deps: Partial<JobDeps> = {},
  expire: Partial<ExpireTranscodedVideosDeps> = {},
) =>
  modelJob({ min: 0 }, async (_args, jobDeps) => {
    const redis = (expire.redis ?? (() => getRedis("main")))();
    const months = await beforeSideEffects(() => recentnessLimitInMonths(redis));

    const columns = Prisma.join(
      COLUMNS.map((name) => column(TRANSCODED_VIDEOS, name)),
      ", ",
    );
    for (;;) {
      await jobDeps.watchReplicaLag();
      const cutoff = ago({ months }, jobDeps.now());
      const videos = await selectRows<TranscodedVideo>(
        Prisma.sql`SELECT ${columns} FROM ${table(TRANSCODED_VIDEOS)} WHERE ${column(TRANSCODED_VIDEOS, "deleted_at")} IS NULL AND ${column(TRANSCODED_VIDEOS, "last_accessed_at")} <= ${cutoff} LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
      );
      if (videos.length === 0) return;

      for (const video of videos) {
        // `streamable` queries the file only with both columns set.
        if (video.streamable_type !== null && video.streamable_id !== null) {
          await beforeSideEffects(() => {
            throw new NotPortedError("TranscodedVideo#mark_deleted!", "transcoded_video.rb (is_transcoded_for_hls)");
          });
        }
        await TranscodedVideoDeletable.markDeletedBang(TranscodedVideos.load(video), { now: jobDeps.now });
      }
    }
  })(deps);

export const expireTranscodedVideosJob = expireTranscodedVideosJobWith();
