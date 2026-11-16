// The Active Storage thumbnails of ProductFile (#thumbnail_url, #as_json's `thumbnail`) and VideoFile (#thumbnail_url).
// A variant Rails has not processed yet is ImageMagick's job, so it throws NotPortedError.
import type { ProductFile } from "@prisma/client";

import { railsCache } from "../../cache/rails-cache.ts";
import {
  blobSignedId,
  isConfiguredService,
  isVariable,
  publicStorageUrl,
  resizeToLimitDigest,
} from "../../infra/active-storage.ts";
import { cdnUrlFor } from "../../infra/cdn-url.ts";
import { isStreamable } from "../../models/product-file.ts";
import { NotPortedError } from "../not-ported.ts";

import { attachmentsOf, blobById, variantBlobKey, variantRecordId, type BlobRow } from "./reads.ts";

// [width, height] of `resize_to_limit` for ProductFile#thumbnail_variant and VideoFile's :preview variant.
const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;
// ProductFile::SUPPORTED_THUMBNAIL_IMAGE_CONTENT_TYPES
const SUPPORTED_THUMBNAIL_CONTENT_TYPES = /jpeg|gif|png|jpg/iu;
// ProductFile::BROWSER_RENDERABLE_IMAGE_FILETYPES
const BROWSER_RENDERABLE_IMAGE_FILETYPES = ["png", "jpg", "jpeg", "gif", "webp"];

async function attachedBlob(
  recordType: string,
  recordId: bigint,
): Promise<{ attachmentId: bigint; blob: BlobRow } | null> {
  const [attachment] = await attachmentsOf(recordType, recordId, "thumbnail");
  if (!attachment) return null;
  const blob = await blobById(attachment.blob_id);
  if (blob === null) throw new NotPortedError("An attachment whose blob row is missing");
  if (!isConfiguredService(blob.service_name))
    throw new NotPortedError(`Active Storage service ${JSON.stringify(blob.service_name)}`);
  return { attachmentId: attachment.id, blob };
}

// `blob.variant(resize_to_limit: [1280, 720])`'s URL once Rails has processed it: the variant record's image blob.
async function processedThumbnailVariantUrl(blob: BlobRow): Promise<string> {
  const digest = resizeToLimitDigest(blob.content_type!, blob.filename, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const recordId = await variantRecordId(blob.id, digest);
  const key = recordId === null ? null : await variantBlobKey(recordId);
  if (key === null || key.trim() === "") throw new NotPortedError("Generating a thumbnail variant");
  return publicStorageUrl(key);
}

const isImage = (blob: BlobRow) => blob.content_type?.startsWith("image/") === true;

// ProductFile#thumbnail_url. Any failure of the variant path falls back to the original's URL, as the rescue does.
async function productFileThumbnailUrl(
  file: Pick<ProductFile, "id" | "filetype" | "filegroup">,
  attached: { attachmentId: bigint; blob: BlobRow },
): Promise<string | null> {
  const { blob } = attached;
  if (BROWSER_RENDERABLE_IMAGE_FILETYPES.includes(file.filetype ?? ""))
    return cdnUrlFor(publicStorageUrl(blob.key)) ?? null;
  try {
    if (
      !isImage(blob) ||
      !SUPPORTED_THUMBNAIL_CONTENT_TYPES.test(blob.content_type!) ||
      !isVariable(blob.content_type)
    ) {
      throw new TypeError("thumbnail_variant is nil");
    }
    const cached = await railsCache().fetch(
      `attachment_product_file_thumbnail_${attached.attachmentId}_variant_url`,
      {},
      () => processedThumbnailVariantUrl(blob),
    );
    return cdnUrlFor(cached) ?? null;
  } catch (error) {
    if (error instanceof NotPortedError) throw error;
    return cdnUrlFor(publicStorageUrl(blob.key)) ?? null;
  }
}

// The `thumbnail` entry of ProductFile#as_json.
export async function productFileThumbnailJson(
  file: ProductFile,
): Promise<{ url: string; signed_id: string; status: { type: "saved" } } | null> {
  if (!isStreamable(file) && !BROWSER_RENDERABLE_IMAGE_FILETYPES.includes(file.filetype ?? "")) return null;
  const attached = await attachedBlob("ProductFile", file.id);
  if (attached === null) return null;
  const url = await productFileThumbnailUrl(file, attached);
  if (url === null || url.trim() === "") return null;
  return { url, signed_id: blobSignedId(attached.blob.id), status: { type: "saved" } };
}

// VideoFile#thumbnail_url: `thumbnail.variant(:preview).url || thumbnail.url` (a variant without a record has no url).
export async function videoFileThumbnailUrl(videoFileId: bigint): Promise<string | null> {
  const attached = await attachedBlob("VideoFile", videoFileId);
  if (attached === null) return null;
  const { blob } = attached;
  if (!isVariable(blob.content_type))
    throw new NotPortedError("VideoFile#thumbnail_url for a thumbnail that cannot be varied");
  const digest = resizeToLimitDigest(blob.content_type!, blob.filename, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const recordId = await variantRecordId(blob.id, digest);
  const key = recordId === null ? null : await variantBlobKey(recordId);
  const url = key !== null && key.trim() !== "" ? publicStorageUrl(key) : publicStorageUrl(blob.key);
  return url.trim() === "" ? null : (cdnUrlFor(url) ?? null);
}
