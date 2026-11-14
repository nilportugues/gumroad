// Port of the guards of app/sidekiq/process_asset_preview_retina_worker.rb: a missing or deleted preview is left alone. A live one goes to
// AssetPreview#generate_retina_variant! (ImageMagick and an S3 upload), which stays with Rails: the job is handed back right after the read.
// Golden: __fixtures__/process-asset-preview-retina-worker.golden.json (scripts/golden/process-asset-preview-retina-worker.rb); the
// variant builder was replaced by a recorder there.
import type { AssetPreview } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const processAssetPreviewRetinaWorkerWith = modelJob({ min: 1 }, async ([assetPreviewId]) => {
  const key =
    assetPreviewId === null
      ? null
      : await beforeSideEffects(() => recordIdFrom(assetPreviewId, "AssetPreview.find_by"));
  const preview = await findOneBy<AssetPreview>("AssetPreview", "id", key, true);
  if (preview === null || preview.deleted_at !== null) return;

  throw new HandBackToRuby("AssetPreview#generate_retina_variant! is not ported");
});

export const processAssetPreviewRetinaWorker = processAssetPreviewRetinaWorkerWith();
