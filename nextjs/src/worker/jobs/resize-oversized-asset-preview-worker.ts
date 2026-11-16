// Port of app/sidekiq/resize_oversized_asset_preview_worker.rb up to `AssetPreview#resize_oversized_image!`. The `find_by(id:)` and the
// `deleted?` check run in Node and finish a missing or deleted preview; a live one means Active Storage reads, a resize and an attach,
// which hand back to Rails before any of them, as does an id Rails casts. Golden:
// __fixtures__/resize-oversized-asset-preview-worker.golden.json (scripts/golden/resize-oversized-asset-preview-worker.rb).
import type { AssetPreview } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const resizeOversizedAssetPreviewWorkerWith = modelJob({ min: 1 }, async ([assetPreviewId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(assetPreviewId, "AssetPreview.find_by"));
  const assetPreview = await findById<AssetPreview>("AssetPreview", id);
  if (assetPreview === null || assetPreview.deleted_at !== null) return;

  throw new HandBackToRuby("a live asset preview is resized");
});
export const resizeOversizedAssetPreviewWorker = resizeOversizedAssetPreviewWorkerWith();
