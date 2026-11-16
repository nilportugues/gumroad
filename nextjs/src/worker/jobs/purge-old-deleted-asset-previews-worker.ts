// Port of app/sidekiq/purge_old_deleted_asset_previews_worker.rb: batches of AssetPreviews deleted over a month ago are destroyed (their
// file attachment, the product touch and cache invalidation, and the PurgeJob for the blob) until none is left.
// Golden: __fixtures__/purge-old-deleted-asset-previews-worker.golden.json (scripts/golden/purge-old-deleted-asset-previews-worker.rb).
import { Prisma, type AssetPreview } from "@prisma/client";

import { destroyAssetPreview } from "../../server/models/asset-preview.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const ASSET_PREVIEWS = "asset_previews";
const DELETION_BATCH_SIZE = 100;

export const purgeOldDeletedAssetPreviewsWorkerWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const to = ago({ months: 1 }, deps.now());
  for (;;) {
    // The raw `deleted_at` in the second condition is Rails' own, left unqualified by the `where` string.
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`asset_previews`.*")} FROM ${table(ASSET_PREVIEWS)} WHERE ${column(ASSET_PREVIEWS, "deleted_at")} IS NOT NULL AND (deleted_at < ${to}) LIMIT ${Prisma.raw(String(DELETION_BATCH_SIZE))}`,
    );
    if (rows.length === 0) return;
    await deps.watchReplicaLag();
    for (const row of rows) await destroyAssetPreview(castRow<AssetPreview>("AssetPreview", row), deps);
  }
});

export const purgeOldDeletedAssetPreviewsWorker = purgeOldDeletedAssetPreviewsWorkerWith();
