// The Link readers the buyer pages share: thumbnails and cover previews. An uploaded thumbnail's URL is read from the variant Rails
// already processed; a cover preview's uploaded file is not ported.
import { Prisma } from "@prisma/client";

import { isConfiguredService, isVariable, publicStorageUrl, resizeToLimitDigest } from "../../infra/active-storage.ts";
import { cdnUrlFor } from "../../infra/cdn-url.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { attachmentsOf, blobById, variantBlobKey, variantRecordId } from "../signed-in/reads.ts";

// Thumbnail::DISPLAY_THUMBNAIL_DIMENSION
const DISPLAY_THUMBNAIL_DIMENSION = 600;

const present = (value: string | null | undefined): value is string => value != null && value.trim() !== "";

export async function hasAttachment(recordType: string, recordId: bigint, name: string): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("active_storage_attachments")} WHERE ${column("active_storage_attachments", "record_type")} = ${recordType} AND ${column("active_storage_attachments", "record_id")} = ${recordId} AND ${column("active_storage_attachments", "name")} = ${name} LIMIT 1`,
  );
  return rows.length > 0;
}

async function thumbnailUrlWhere(productId: bigint, aliveOnly: boolean): Promise<string | null> {
  const deleted = aliveOnly ? Prisma.sql` AND ${column("thumbnails", "deleted_at")} IS NULL` : Prisma.empty;
  const [thumbnail] = await selectRows<{ id: bigint; unsplash_url: string | null }>(
    Prisma.sql`SELECT ${column("thumbnails", "id")}, ${column("thumbnails", "unsplash_url")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} = ${productId}${deleted} ORDER BY ${column("thumbnails", "id")} ASC LIMIT 1`,
  );
  if (!thumbnail) return null;
  if (present(thumbnail.unsplash_url)) return thumbnail.unsplash_url;
  return uploadedThumbnailUrl(thumbnail.id);
}

// Thumbnail#url for an uploaded file: a gif, and a file Active Storage cannot transform (which Rails rescues), answer the file's own URL;
// any other image answers the 600px variant's URL, through the CDN rewrite. A variant Rails has not processed yet is made by
// ImageMagick, which Rails keeps.
async function uploadedThumbnailUrl(thumbnailId: bigint): Promise<string | null> {
  const [attachment] = await attachmentsOf("Thumbnail", thumbnailId, "file");
  if (attachment === undefined) return null;
  const blob = await blobById(attachment.blob_id);
  if (blob === null) throw new NotPortedError("Thumbnail#url for an attachment whose blob row is missing");
  if (!isConfiguredService(blob.service_name))
    throw new NotPortedError(`Active Storage service ${JSON.stringify(blob.service_name)}`);
  const original = cdnUrlFor(publicStorageUrl(blob.key)) ?? null;
  if (blob.content_type?.includes("gif")) return original;
  if (!isVariable(blob.content_type)) return original;
  const digest = resizeToLimitDigest(blob.content_type!, blob.filename, DISPLAY_THUMBNAIL_DIMENSION);
  const recordId = await variantRecordId(blob.id, digest);
  if (recordId === null) throw new NotPortedError("Generating a thumbnail variant");
  const key = await variantBlobKey(recordId);
  if (key === null) throw new NotPortedError("A thumbnail variant record without its file");
  return cdnUrlFor(publicStorageUrl(key)) ?? null;
}

// `thumbnail_alive&.url`
export const thumbnailUrl = (productId: bigint) => thumbnailUrlWhere(productId, true);

// `thumbnail&.url`: the has_one without the alive scope, so a soft-deleted thumbnail still answers.
export const anyThumbnailUrl = (productId: bigint) => thumbnailUrlWhere(productId, false);

// `thumbnail_alive&.url || display_asset_previews.find(&:image_url?)&.url`
export async function thumbnailOrCoverUrl(productId: bigint): Promise<string | null> {
  const thumbnail = await thumbnailUrl(productId);
  if (thumbnail !== null) return thumbnail;

  // AssetPreview.alive.in_order
  const previews = await selectRows<{ id: bigint; unsplash_url: string | null }>(
    Prisma.sql`SELECT ${column("asset_previews", "id")}, ${column("asset_previews", "unsplash_url")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${productId} AND ${column("asset_previews", "deleted_at")} IS NULL ORDER BY ${column("asset_previews", "position")} ASC, ${column("asset_previews", "created_at")} ASC`,
  );
  for (const preview of previews) {
    if (present(preview.unsplash_url)) return preview.unsplash_url;
    if (await hasAttachment("AssetPreview", preview.id, "file"))
      throw new NotPortedError("AssetPreview#url for an uploaded file");
  }
  return null;
}
