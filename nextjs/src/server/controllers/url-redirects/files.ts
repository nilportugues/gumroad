// What UrlRedirect asks of its product files: which are alive for the redirect, their signed locations and the transcoded video
// bookkeeping a delivery triggers. Shapes the port does not prove (SKUs, several or shared versions, stamped PDFs, preorders) hand the request
// back to Rails before it writes anything.
import { Prisma, type BaseVariant, type ProductFile } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { signedDownloadUrlForS3KeyAndFilename } from "../../infra/signed-urls.ts";
import { LinkFlags } from "../../models/link.ts";
import {
  filenameWithExtension,
  isExternalLink,
  isListenable,
  isStreamable,
  isStreamOnly,
  mustBePdfStamped,
  ProductFileFlags,
  rubyExtname,
  s3Fields,
  type S3Fields,
} from "../../models/product-file.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";
import { HandBackToRails } from "../application-controller.ts";

import type { Loaded } from "./access.ts";

export type DeliveryFile = { file: ProductFile; s3: S3Fields | null };

const ownerExternalId = (loaded: Loaded) => (loaded.product?.user_id == null ? null : encrypt(loaded.product.user_id));

export const fieldsOf = (file: ProductFile, loaded: Loaded) => s3Fields(file.url, ownerExternalId(loaded));

// UrlRedirect#with_product_files and #rich_content_provider for a redirect without an installment: the one alive version
// (Variant) a purchase bought, or the product. A purchase of a SKU, of several versions or of a deleted one picks its
// provider by other rules; so does a product whose versions share one set of pages.
export type ContentProvider = { kind: "product" } | { kind: "variant"; variant: BaseVariant };

export async function contentProvider({
  purchase,
  product,
}: Pick<Loaded, "purchase" | "product">): Promise<ContentProvider> {
  if (!purchase || product === null) return { kind: "product" };
  const links = await db.baseVariantsPurchase.findMany({ where: { purchase_id: Number(purchase.id) } });
  if (links.length === 0) return { kind: "product" };
  const variants = await db.baseVariant.findMany({
    where: { id: { in: links.flatMap((link) => link.base_variant_id ?? []) } },
  });
  if (variants.length !== links.length || variants.some((variant) => variant.type !== "Variant"))
    throw new HandBackToRails("a purchase of a SKU");
  const [variant] = variants;
  if (variants.length > 1 || variant === undefined) throw new HandBackToRails("a purchase of several versions");
  if (variant.deleted_at !== null) throw new HandBackToRails("a purchase of a deleted version");
  const category = await db.variantCategory.findUnique({ where: { id: variant.variant_category_id ?? 0 } });
  if (category === null || category.link_id !== Number(product.id)) throw new HandBackToRails("an orphaned version");
  if (LinkFlags.isSet(product.flags, "has_same_rich_content_for_all_variants"))
    throw new HandBackToRails("versions that share one set of pages");
  return { kind: "variant", variant };
}

// UrlRedirect#alive_product_files for the provider: its own files in order. With `embedded` (the file ids its rich content
// pages embed, in order) only those are listed, as Rails does once a page embeds one; without it a provider with rich
// content hands back. Only the download page and the caption actions prove a purchased version's files (`versions`); every other delivery hands it back.
export async function aliveProductFiles(
  loaded: Loaded,
  embedded?: bigint[],
  { versions = false }: { versions?: boolean } = {},
): Promise<DeliveryFile[]> {
  const { redirect, product } = loaded;
  if (redirect.preorder_id !== null) throw new HandBackToRails("a url redirect of a preorder");
  if (product === null) return [];
  const provider = await contentProvider(loaded);
  if (provider.kind === "variant" && !versions) throw new HandBackToRails("a purchase of a version");
  if (provider.kind === "product" && (await db.variantCategory.count({ where: { link_id: Number(product.id) } })) > 0)
    throw new HandBackToRails("a product with variants");
  if (embedded === undefined && (await hasRichPages(provider, product.id)))
    throw new HandBackToRails("a provider with rich content");
  const listed = embedded ?? [];
  const owned =
    provider.kind === "variant" ? { id: { in: await variantFileIds(provider.variant.id) } } : { link_id: product.id };
  const found = await db.productFile.findMany({
    where: { AND: [owned, { deleted_at: null }, ...(listed.length > 0 ? [{ id: { in: listed } }] : [])] },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  // FIELD(product_files.id, ids)
  const files = listed.length > 0 ? [...found].sort((a, b) => listed.indexOf(a.id) - listed.indexOf(b.id)) : found;
  if (files.some(mustBePdfStamped)) throw new HandBackToRails("a stamped PDF");
  return files.map((file) => ({ file, s3: fieldsOf(file, loaded) }));
}

// Joined on Int ids: base_variants_product_files.product_file_id is an INT, product_files.id a BIGINT.
async function variantFileIds(variantId: number): Promise<bigint[]> {
  const joins = await db.baseVariantsProductFile.findMany({ where: { base_variant_id: variantId } });
  return joins.flatMap((join) => (join.product_file_id === null ? [] : [BigInt(join.product_file_id)]));
}

async function hasRichPages(provider: ContentProvider, productId: bigint): Promise<boolean> {
  const where =
    provider.kind === "variant"
      ? { entity_type: "BaseVariant", entity_id: BigInt(provider.variant.id) }
      : { entity_type: "Link", entity_id: productId };
  return (await db.richContent.count({ where: { ...where, deleted_at: null } })) > 0;
}

// UrlRedirect#is_file_downloadable?
export async function isFileDownloadable(loaded: Loaded, { file }: DeliveryFile): Promise<boolean> {
  if (isExternalLink(file)) return false;
  if (isStreamable(file) && UrlRedirectFlags.isSet(loaded.redirect.flags, "is_rental")) return false;
  if (!isStreamOnly(file)) return true;
  return (
    (await db.productFileDownloadGrant.count({
      where: { url_redirect_id: loaded.redirect.id, product_file_id: file.id },
    })) > 0
  );
}

export class StorageObjectMissing extends Error {}

// A HEAD miss (after the signer's Unicode-normalization retry) is the NotFound the controllers rescue.
export async function signedUrl(
  s3: S3Fields,
  options: { isVideo?: boolean; cacheGroup?: string } = {},
): Promise<string> {
  try {
    return await signedDownloadUrlForS3KeyAndFilename(s3.key, s3.filename, options);
  } catch (error) {
    const notFound =
      (error as { name?: string }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
    if (!notFound) throw error;
    throw new StorageObjectMissing(s3.key);
  }
}

// UrlRedirect#signed_location_for_file; stamped PDFs were handed back with the files.
export async function signedLocationForFile({ file, s3 }: DeliveryFile): Promise<string | null> {
  if (isExternalLink(file)) return file.url;
  if (s3 === null) throw new HandBackToRails("a file that is not in S3");
  const filename =
    s3.extension === "" ? `${s3.filename}${rubyExtname(filenameWithExtension(file, s3) ?? "")}` : s3.filename;
  return signedUrl({ ...s3, filename }, { isVideo: isStreamable(file) });
}

export const displayFilename = ({ file, s3 }: DeliveryFile) => filenameWithExtension(file, s3);

// UrlRedirect#hls_rendition_available?
async function hlsRenditionAvailable({ file, s3 }: DeliveryFile): Promise<boolean> {
  if (ProductFileFlags.isSet(file.flags, "is_transcoded_for_hls")) return true;
  if (s3 === null) return false;
  const HLS = 1;
  const rows = await db.transcodedVideo.findMany({
    where: {
      streamable_type: "ProductFile",
      streamable_id: file.id,
      deleted_at: null,
      state: "completed",
      original_video_key: s3.key,
    },
    select: { flags: true },
  });
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
  const alive = await db.transcodedVideo.findMany({
    where: { streamable_type: "ProductFile", streamable_id: { in: videoIds }, deleted_at: null },
    select: { streamable_id: true },
  });
  const aliveIds = new Set(alive.map((row) => row.streamable_id));
  const missing = videoIds.filter((id) => !aliveIds.has(id));
  if (missing.length > 0) {
    const deletedCompleted = await db.transcodedVideo.count({
      where: {
        streamable_type: "ProductFile",
        streamable_id: { in: missing },
        deleted_at: { not: null },
        state: "completed",
      },
    });
    if (deletedCompleted > 0) throw new HandBackToRails("a video whose transcodes were deleted");
  }
  if (alive.length > 0)
    await db.$executeRaw`UPDATE transcoded_videos SET last_accessed_at = ${now} WHERE deleted_at IS NULL AND streamable_type = 'ProductFile' AND streamable_id IN (${Prisma.join(videoIds)})`;
}
