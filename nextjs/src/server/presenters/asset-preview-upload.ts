// Port of the uploaded-image half of app/models/asset_preview.rb (`url`, `url_from_file`, `retina_variant`, `filetype`). The URL of
// an image is its public bucket URL, or its retina variant's once ProcessAssetPreviewRetinaWorker has made one; an unprocessed
// variant is enqueued on every read, as Rails does. Videos (posters), failed lookups and anything Rails would raise on stay with Rails.
import { Prisma } from "@prisma/client";

import { railsCache } from "../cache/rails-cache.ts";
import { isConfiguredService, isVariable, publicStorageUrl, resizeToLimitDigest } from "../infra/active-storage.ts";
import { cdnUrlFor } from "../infra/cdn-url.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../page-props/not-ported.ts";
import { variantBlobKey, variantRecordId } from "../page-props/signed-in/reads.ts";

import { displaySize, type CoverRow } from "./asset-preview.ts";

const RETINA_DISPLAY_WIDTH = 1005;
const SOURCE = "AssetPreview#as_json for an upload Node cannot read exactly";
const handBack = (): never => {
  throw new NotPortedError(SOURCE);
};

export type UploadedFile = {
  attachment_id: bigint;
  blob_id: bigint;
  key: string;
  filename: string;
  content_type: string | null;
  service_name: string;
  metadata: string | null;
};

// The `file` attachments of these previews, by preview id.
export async function uploadedFiles(previewIds: bigint[]): Promise<Map<bigint, UploadedFile[]>> {
  const attachments = (name: string) => column("active_storage_attachments", name);
  const blobs = (name: string) => column("active_storage_blobs", name);
  const rows = await selectRows<UploadedFile & { record_id: bigint }>(
    Prisma.sql`SELECT ${attachments("record_id")}, ${attachments("id")} AS attachment_id, ${attachments("blob_id")} AS blob_id, ${blobs("key")}, ${blobs("filename")}, ${blobs("content_type")}, ${blobs("service_name")}, ${blobs("metadata")} FROM ${table("active_storage_attachments")} INNER JOIN ${table("active_storage_blobs")} ON ${blobs("id")} = ${attachments("blob_id")} WHERE ${attachments("record_type")} = 'AssetPreview' AND ${attachments("name")} = 'file' AND ${attachments("record_id")} IN (${Prisma.join(previewIds)}) ORDER BY ${attachments("id")} ASC`,
  );
  const byPreview = new Map<bigint, UploadedFile[]>();
  for (const row of rows) byPreview.set(row.record_id, [...(byPreview.get(row.record_id) ?? []), row]);
  return byPreview;
}

// File.extname(filename), else the content type's subtype.
function filetype(filename: string, contentType: string): string {
  const base = filename.replace(/^.*\//u, "").replace(/^\.+/u, "");
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 && dot < base.length - 1 ? base.slice(dot + 1) : "";
  return extension !== "" ? extension : contentType.split("/").pop()!;
}

const dimension = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

export async function uploadedCoverAsJson(
  previewId: bigint,
  row: CoverRow,
  files: UploadedFile[],
): Promise<Record<string, unknown>> {
  // `url=` purges the file when the URL is oEmbed-embeddable, and a photo beside an upload is a state no request makes.
  if (files.length !== 1 || row.oembed !== null || row.unsplash_url !== null) return handBack();
  const file = files[0]!;
  const contentType = file.content_type;
  if (!isConfiguredService(file.service_name) || !contentType?.startsWith("image/")) return handBack();
  const metadata = file.metadata === null ? null : (JSON.parse(file.metadata) as Record<string, unknown>);
  const width = dimension(metadata?.width);
  const height = dimension(metadata?.height);
  if (width === null || height === null) return handBack();

  const cache = railsCache();
  const original = () =>
    cache.fetch(`attachment_${file.attachment_id}_original_url`, {}, () => publicStorageUrl(file.key));
  let url: string;
  if (contentType.includes("gif")) {
    url = await original();
  } else if (!isVariable(contentType)) {
    // `file.variant` raises, and `url_from_file` rescues to the file's own URL.
    url = publicStorageUrl(file.key);
  } else {
    const digest = resizeToLimitDigest(contentType, file.filename, Math.min(RETINA_DISPLAY_WIDTH, width), null);
    const recordId = await variantRecordId(file.blob_id, digest);
    if (recordId === null) {
      await enqueue("ProcessAssetPreviewRetinaWorker", [Number(previewId)]);
      url = await original();
    } else {
      const key = await variantBlobKey(recordId);
      if (key === null || key.trim() === "") return handBack();
      url = await cache.fetch(`attachment_${file.attachment_id}_retina_url`, {}, () => publicStorageUrl(key));
    }
  }

  const { displayWidth, displayHeight } = displaySize(width, height);
  return {
    url: cdnUrlFor(url),
    original_url: cdnUrlFor(await original()),
    thumbnail: null,
    id: row.guid,
    type: "image",
    filetype: filetype(file.filename, contentType),
    width: displayWidth,
    height: displayHeight,
    native_width: width,
    native_height: height,
  };
}
