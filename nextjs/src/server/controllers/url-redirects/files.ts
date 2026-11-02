// What UrlRedirect asks of its product files: which are alive for the redirect, their signed locations and the transcoded video
// bookkeeping a delivery triggers. Shapes the port does not prove (rich content, variants, stamped PDFs, preorders) hand the request
// back to Rails before it writes anything.
import { Prisma, type ProductFile } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { signedDownloadUrlForS3KeyAndFilename } from "../../infra/signed-urls.ts";
import { filenameWithExtension, isExternalLink, isListenable, isStreamable, isStreamOnly, mustBePdfStamped, ProductFileFlags, rubyExtname, s3Fields, type S3Fields } from "../../models/product-file.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { HandBackToRails } from "../application-controller.ts";
import type { Loaded } from "./access.ts";

export type DeliveryFile = { file: ProductFile; s3: S3Fields | null };

const ownerExternalId = (loaded: Loaded) => (loaded.product?.user_id == null ? null : encrypt(loaded.product.user_id));

export const fieldsOf = (file: ProductFile, loaded: Loaded) => s3Fields(file.url, ownerExternalId(loaded));

// UrlRedirect#alive_product_files for the shapes that do not depend on rich content or variants: the product's own files in order.
export async function aliveProductFiles(loaded: Loaded): Promise<DeliveryFile[]> {
  const { redirect, purchase, product } = loaded;
  if (redirect.preorder_id !== null) throw new HandBackToRails("a url redirect of a preorder");
  if (product === null) return [];
  if (purchase) {
    const purchased = await db.baseVariantsPurchase.count({ where: { purchase_id: Number(purchase.id) } });
    if (purchased > 0) throw new HandBackToRails("a purchase of a variant");
  }
  if ((await db.variantCategory.count({ where: { link_id: Number(product.id) } })) > 0) throw new HandBackToRails("a product with variants");
  if ((await db.richContent.count({ where: { entity_type: "Link", entity_id: product.id, deleted_at: null } })) > 0) throw new HandBackToRails("a product with rich content");
  const files = await db.productFile.findMany({ where: { link_id: product.id, deleted_at: null }, orderBy: [{ position: "asc" }, { id: "asc" }] });
  if (files.some(mustBePdfStamped)) throw new HandBackToRails("a stamped PDF");
  return files.map((file) => ({ file, s3: fieldsOf(file, loaded) }));
}

// UrlRedirect#is_file_downloadable?
export async function isFileDownloadable(loaded: Loaded, { file }: DeliveryFile): Promise<boolean> {
  if (isExternalLink(file)) return false;
  if (isStreamable(file) && UrlRedirectFlags.isSet(loaded.redirect.flags, "is_rental")) return false;
  if (!isStreamOnly(file)) return true;
  return (await db.productFileDownloadGrant.count({ where: { url_redirect_id: loaded.redirect.id, product_file_id: file.id } })) > 0;
}

export class StorageObjectMissing extends Error {}

// A HEAD miss is the NotFound the controllers rescue. A key with non-ASCII characters is retried by Rails under the other Unicode
// normalization forms, which the port does not do.
export async function signedUrl(s3: S3Fields, options: { isVideo?: boolean; cacheGroup?: string } = {}): Promise<string> {
  try {
    return await signedDownloadUrlForS3KeyAndFilename(s3.key, s3.filename, options);
  } catch (error) {
    const notFound = (error as { name?: string }).name === "NotFound" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
    if (!notFound) throw error;
    // eslint-disable-next-line no-control-regex
    if (/[^\u0000-\u007f]/u.test(s3.key)) throw new HandBackToRails("a missing key with non-ASCII characters");
    throw new StorageObjectMissing(s3.key);
  }
}

// UrlRedirect#signed_location_for_file; stamped PDFs were handed back with the files.
export async function signedLocationForFile({ file, s3 }: DeliveryFile): Promise<string | null> {
  if (isExternalLink(file)) return file.url;
  if (s3 === null) throw new HandBackToRails("a file that is not in S3");
  const filename = s3.extension === "" ? `${s3.filename}${rubyExtname(filenameWithExtension(file, s3) ?? "")}` : s3.filename;
  return signedUrl({ ...s3, filename }, { isVideo: isStreamable(file) });
}

export const displayFilename = ({ file, s3 }: DeliveryFile) => filenameWithExtension(file, s3);

// UrlRedirect#hls_rendition_available?
async function hlsRenditionAvailable({ file, s3 }: DeliveryFile): Promise<boolean> {
  if (ProductFileFlags.isSet(file.flags, "is_transcoded_for_hls")) return true;
  if (s3 === null) return false;
  const HLS = 1;
  const rows = await db.transcodedVideo.findMany({ where: { streamable_type: "ProductFile", streamable_id: file.id, deleted_at: null, state: "completed", original_video_key: s3.key }, select: { flags: true } });
  return rows.some((row) => (row.flags & HLS) !== 0);
}

// UrlRedirect#hls_playlist_or_smil_xml_path
export async function hlsPlaylistOrSmilPath(token: string, delivery: DeliveryFile): Promise<string> {
  const id = encrypt(delivery.file.id);
  return (await hlsRenditionAvailable(delivery)) ? `/r/${token}/${id}/index.m3u8` : `/r/${token}/${id}/stream.smil`;
}

export const isMedia = ({ file }: DeliveryFile) => isStreamable(file) || isListenable(file);

// UrlRedirect#update_transcoded_videos_last_accessed_at and #enqueue_job_to_regenerate_deleted_transcoded_videos. A video whose
// transcodes were deleted needs a TranscodeVideoForStreamingWorker; that request goes to Rails before this writes.
export async function triggerFilesLifecycleEvents(files: DeliveryFile[], now: Date): Promise<void> {
  const videoIds = files.filter(({ file }) => file.filegroup === "video").map(({ file }) => file.id);
  if (videoIds.length === 0) return;
  const alive = await db.transcodedVideo.findMany({ where: { streamable_type: "ProductFile", streamable_id: { in: videoIds }, deleted_at: null }, select: { streamable_id: true } });
  const aliveIds = new Set(alive.map((row) => row.streamable_id));
  const missing = videoIds.filter((id) => !aliveIds.has(id));
  if (missing.length > 0) {
    const deletedCompleted = await db.transcodedVideo.count({ where: { streamable_type: "ProductFile", streamable_id: { in: missing }, deleted_at: { not: null }, state: "completed" } });
    if (deletedCompleted > 0) throw new HandBackToRails("a video whose transcodes were deleted");
  }
  if (alive.length > 0) await db.$executeRaw`UPDATE transcoded_videos SET last_accessed_at = ${now} WHERE deleted_at IS NULL AND streamable_type = 'ProductFile' AND streamable_id IN (${Prisma.join(videoIds)})`;
}

