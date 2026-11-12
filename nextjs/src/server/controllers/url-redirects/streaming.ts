// UrlRedirectsController#smil, #hls_playlist and #download_subtitle_file: the playlist and caption deliveries of the video player.
import path from "node:path";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { db } from "../../../lib/db.ts";
import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { cgiEscape, getS3Client, signedCloudfrontUrl } from "../../infra/signed-urls.ts";
import { storageConfig } from "../../infra/storage.ts";
import { InvalidSubtitleEncoding, subtitleToVtt } from "../../services/subtitle-to-vtt.ts";
import { isStreamable } from "../../models/product-file.ts";
import {
  HandBackToRails,
  RoutingError,
  type ActionContext,
  type ActionResult,
  type Rendered,
} from "../application-controller.ts";
import { json } from "../json-actions.ts";
import { requestFormat } from "../rails-params.ts";
import {
  checkPermissions,
  createConsumptionEvent,
  loadRedirect,
  requireSellerForTestPurchase,
  type Loaded,
} from "./access.ts";
import {
  aliveProductFiles,
  fieldsOf,
  isFileDownloadable,
  signedUrl,
  StorageObjectMissing,
  type DeliveryFile,
} from "./files.ts";
import { UrlRedirectFlags } from "../../models/url-redirect.ts";

const HLS_CONTENT_TYPE = "application/x-mpegurl; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const HLS_FLAG = 1;

const plain = (body: string, contentType: string): Rendered => ({ status: 200, body, contentType, paramsRead: true });

// Builder::XmlMarkup escapes attribute values
const xmlAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// UrlRedirect#product_file(external id)
export function findFile(files: DeliveryFile[], externalId: string): DeliveryFile | undefined {
  const id = decrypt(externalId);
  return id === null ? undefined : files.find(({ file }) => file.id === BigInt(id));
}

// #mark_rental_as_viewed (`update!(rental_first_viewed_at: Time.current)`)
async function markRentalAsViewed(loaded: Loaded, now: Date): Promise<void> {
  const { redirect } = loaded;
  if (UrlRedirectFlags.isSet(redirect.flags, "is_rental") && redirect.rental_first_viewed_at === null) {
    await db.$executeRaw`UPDATE url_redirects SET rental_first_viewed_at = ${now}, updated_at = ${now} WHERE id = ${redirect.id}`;
  }
}

function forbiddenTestPurchase(loaded: Loaded, action: ActionContext): Rendered | null {
  if (requireSellerForTestPurchase(loaded, action) !== "forbidden") return null;
  if (requestFormat(action.request) === "json") return json({ success: false, error: "Not found" }, 404);
  throw new RoutingError("Not Found");
}

// #smil
export async function smil(token: string, fileId: string, action: ActionContext): Promise<ActionResult> {
  const loaded = await loadRedirect(token);
  const forbidden = forbiddenTestPurchase(loaded, action);
  if (forbidden) return forbidden;
  const now = new Date();
  await markRentalAsViewed(loaded, now);
  const delivery = findFile(await aliveProductFiles(loaded), fileId);
  if (!delivery) throw new RoutingError("Not Found");
  const key = delivery.s3?.key;
  if (key === undefined) throw new TypeError("undefined method 'to_s' for nil");
  const body = `<smil><body><switch><video src="${xmlAttribute(signedCloudfrontUrl(key, { isVideo: true }))}"/></switch></body></smil>`;
  await createConsumptionEvent(loaded, action.request, "watch", delivery.file.id, now);
  return plain(body, TEXT_CONTENT_TYPE);
}

// ProductFile#hls_playlist: the transcoder's master playlist with every rendition's playlist behind a signed URL.
async function hlsPlaylist(file: DeliveryFile["file"]): Promise<string | null> {
  const transcoded = await db.transcodedVideo.findFirst({
    where: { streamable_type: "ProductFile", streamable_id: file.id, deleted_at: null, state: "completed" },
    orderBy: { id: "desc" },
  });
  // The is_hls flag is a bit, so it is checked on the candidates in order: the last one that has it.
  const hls = transcoded && (transcoded.flags & HLS_FLAG) !== 0 ? transcoded : await lastHls(file);
  if (hls === null || hls.transcoded_video_key === null) return null;

  const playlistKey = hls.transcoded_video_key;
  const prefix = `${path.posix.dirname(playlistKey)}/`;
  let playlist: string;
  try {
    const object = await getS3Client().send(
      new GetObjectCommand({ Bucket: storageConfig().s3Bucket, Key: playlistKey }),
    );
    playlist = await object.Body!.transformToString();
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    throw error;
  }
  const original = prefix.includes("/original/")
    ? /\/original\/(.*?)\/hls/su.exec(prefix)?.[1]
    : /attachments\/.*\/(.*?)\/hls/su.exec(prefix)?.[1];
  const lines = playlist.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let signed = "";
  for (const line of lines) {
    if (line.startsWith("#")) {
      signed += `${line}\n`;
      continue;
    }
    if (original === undefined) throw new TypeError("no implicit conversion of nil into String");
    const key = `${prefix}${line}`.replaceAll(original, () => cgiEscape(original));
    signed += `${signedCloudfrontUrl(`${storageConfig().hlsDistributionUrl}${key}`, { isVideo: true })}\n`;
  }
  return signed;
}

async function lastHls(file: DeliveryFile["file"]) {
  const rows = await db.transcodedVideo.findMany({
    where: { streamable_type: "ProductFile", streamable_id: file.id, deleted_at: null, state: "completed" },
    orderBy: { id: "desc" },
  });
  return rows.find((row) => (row.flags & HLS_FLAG) !== 0) ?? null;
}

// #hls_playlist
export async function hlsPlaylistAction(token: string, fileId: string, action: ActionContext): Promise<ActionResult> {
  const loaded = await loadRedirect(token);
  const halted = await checkPermissions({ loaded, action, actionName: "hls_playlist" });
  if (halted) return halted;
  const now = new Date();
  await markRentalAsViewed(loaded, now);
  const files = await aliveProductFiles(loaded);
  const delivery = findFile(files, fileId) ?? files[0];
  if (!delivery) throw new RoutingError("Not Found");
  const data = await hlsPlaylist(delivery.file);
  if (data === null || data === "") throw new RoutingError("Not Found");
  await createConsumptionEvent(loaded, action.request, "watch", delivery.file.id, now);
  return plain(data, HLS_CONTENT_TYPE);
}

// #download_subtitle_file
export async function downloadSubtitleFile(
  token: string,
  fileId: string,
  subtitleId: string,
  action: ActionContext,
): Promise<ActionResult> {
  const loaded = await loadRedirect(token);
  const halted = await checkPermissions({ loaded, action, actionName: "download_subtitle_file" });
  if (halted) return halted;
  const delivery = findFile(await aliveProductFiles(loaded), fileId);
  if (!delivery) throw new RoutingError("Not Found");
  if (!(await isFileDownloadable(loaded, delivery))) throw new RoutingError("Not Found");
  const id = decrypt(subtitleId);
  const subtitle =
    id === null
      ? null
      : await db.subtitleFile.findFirst({
          where: { id: BigInt(id), product_file_id: delivery.file.id, deleted_at: null },
        });
  if (!subtitle) throw new RoutingError("Not Found");
  const fields = fieldsOf({ ...delivery.file, url: subtitle.url }, loaded);
  if (fields === null) throw new RoutingError("Not Found");
  try {
    return { status: 302, location: await signedUrl(fields, { isVideo: true }) };
  } catch (error) {
    if (error instanceof StorageObjectMissing) throw new Error("Aws::S3::Errors::NotFound");
    throw error;
  }
}

export const isVideo = isStreamable;

const VTT_CONTENT_TYPE = "text/vtt; charset=utf-8";
// expires_in 1.hour, public: false
const VTT_CACHE_CONTROL = "max-age=3600, private";

// #subtitle_file_vtt: the stored caption file as WebVTT. A file that went missing, or any S3 service error, is a 404 so the player
// shows no captions instead of an error. Rails.cache memoizes the conversion for a day; that cache is not observable.
export async function subtitleFileVtt(
  token: string,
  fileId: string,
  subtitleId: string,
  action: ActionContext,
): Promise<ActionResult> {
  const loaded = await loadRedirect(token);
  const halted = await checkPermissions({ loaded, action, actionName: "subtitle_file_vtt" });
  if (halted) return halted;
  const delivery = findFile(await aliveProductFiles(loaded), fileId);
  if (!delivery) throw new RoutingError("Not Found");
  const id = decrypt(subtitleId);
  const subtitle =
    id === null
      ? null
      : await db.subtitleFile.findFirst({
          where: { id: BigInt(id), product_file_id: delivery.file.id, deleted_at: null },
        });
  if (!subtitle) throw new RoutingError("Not Found");
  const fields = fieldsOf({ ...delivery.file, url: subtitle.url }, loaded);
  if (fields === null) throw new HandBackToRails("a subtitle file that is not in S3");
  let bytes: Uint8Array;
  try {
    const object = await getS3Client().send(
      new GetObjectCommand({ Bucket: storageConfig().s3Bucket, Key: fields.key }),
    );
    bytes = await object.Body!.transformToByteArray();
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== undefined)
      throw new RoutingError("Not Found");
    throw error;
  }
  try {
    return { ...plain(subtitleToVtt(bytes), VTT_CONTENT_TYPE), headers: { "cache-control": VTT_CACHE_CONTROL } };
  } catch (error) {
    if (error instanceof InvalidSubtitleEncoding) throw new HandBackToRails("a subtitle file that is not UTF-8");
    throw error;
  }
}
