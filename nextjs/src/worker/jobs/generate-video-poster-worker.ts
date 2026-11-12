// Port of app/sidekiq/generate_video_poster_worker.rb up to `AssetPreview#generate_video_poster!`. The `find_by(id:)` and the `deleted?`
// check run in Node and finish a missing or deleted preview; a live one means Active Storage reads and ffmpeg, which hand back to Rails
// before any of them, as does an id Rails casts. Golden: __fixtures__/generate-video-poster-worker.golden.json
// (scripts/golden/generate-video-poster-worker.rb).
import type { AssetPreview } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const generateVideoPosterWorkerWith = modelJob({ min: 1 }, async ([assetPreviewId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(assetPreviewId, "AssetPreview.find_by"));
  const assetPreview = await findById<AssetPreview>("AssetPreview", id);
  if (assetPreview === null || assetPreview.deleted_at !== null) return;

  throw new HandBackToRuby("a live asset preview gets a video poster");
});
export const generateVideoPosterWorker = generateVideoPosterWorkerWith();
