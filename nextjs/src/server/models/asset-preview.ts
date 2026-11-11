// Port of app/models/asset_preview.rb for PurgeOldDeletedAssetPreviewsWorker: `destroy!`, with the file attachment that
// `has_one_attached :file` destroys, the `belongs_to :link, touch: true` touch and the `after_commit :invalidate_product_cache`.
// Nothing else of the model (validations, creation callbacks, URLs) is ported.
import { Prisma, type ActiveStorageAttachment, type AssetPreview, type Link } from "@prisma/client";

import { purgeBlobLater } from "./active-storage-blob.ts";
import { Links, invalidateProductCache } from "./link.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";

const ATTACHMENTS = "active_storage_attachments";
const ASSET_PREVIEWS = "asset_previews";
const FILE_ATTACHMENT_NAME = "file";

export type AssetPreviewDeps = { now: () => Date; uuid: () => string };

// `asset_preview.file_attachment`, the has_one that `dependent: :destroy` loads before the preview is deleted.
async function fileAttachment(preview: AssetPreview): Promise<ActiveStorageAttachment | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table(ATTACHMENTS)} WHERE ${column(ATTACHMENTS, "record_id")} = ${preview.id} AND ${column(ATTACHMENTS, "record_type")} = 'AssetPreview' AND ${column(ATTACHMENTS, "name")} = ${FILE_ATTACHMENT_NAME} LIMIT 1`,
  );
  return row ? castRow<ActiveStorageAttachment>("ActiveStorageAttachment", row) : null;
}

// `preview.destroy!`
export async function destroyAssetPreview(preview: AssetPreview, deps: AssetPreviewDeps): Promise<void> {
  const { attachment, link } = await transaction(async () => {
    const attachment = await fileAttachment(preview);
    // The attachment touches its record, which touches the product, so the product is read as soon as the attachment is gone.
    let link: Link | null = null;
    if (attachment) {
      await execute(
        Prisma.sql`DELETE FROM ${table(ATTACHMENTS)} WHERE ${column(ATTACHMENTS, "id")} = ${attachment.id}`,
      );
      link = await findById<Link>("Link", preview.link_id);
    }
    await execute(
      Prisma.sql`DELETE FROM ${table(ASSET_PREVIEWS)} WHERE ${column(ASSET_PREVIEWS, "id")} = ${preview.id}`,
    );
    if (!attachment) link = await findById<Link>("Link", preview.link_id);
    if (link) await Links.touch(Links.load(link), { now: deps.now, deferred: true });
    return { attachment, link };
  });

  // after_commit callbacks: the preview's, then the attachment's `purge_dependent_blob_later`.
  if (link) await invalidateProductCache(link.id, deps.now);
  if (attachment) {
    const blob = await findOneBy<{ id: bigint }>("ActiveStorageBlob", "id", attachment.blob_id);
    if (blob) await purgeBlobLater(blob.id, deps.uuid);
  }
}
