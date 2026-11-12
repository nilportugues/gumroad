// UrlRedirectsController#stream (GET /s/:id and /s/:id/:product_file_id) and #read (GET /read/:id and /read/:id/:product_file_id):
// the access gate, the props UrlRedirectPresenter builds for UrlRedirects/Stream and UrlRedirects/Read, and the after_actions that
// count the visit. #stream writes no consumption event (the page's own script does); #read writes the read event.
import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import {
  HandBackToRails,
  RoutingError,
  type Chain,
  type FilterOutcome,
} from "../../controllers/application-controller.ts";
import { requireHtml } from "../../controllers/buyer-pages.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { queryParam } from "../../controllers/rails-request.ts";
import { createConsumptionEvent } from "../../controllers/url-redirects/access.ts";
import {
  aliveProductFiles,
  fieldsOf,
  hlsPlaylistOrSmilPath,
  signedUrl,
  StorageObjectMissing,
  triggerFilesLifecycleEvents,
  type DeliveryFile,
} from "../../controllers/url-redirects/files.ts";
import { findFile } from "../../controllers/url-redirects/streaming.ts";
import { LinkFlags } from "../../models/link.ts";
import { browserReadable, isEpub, isStreamable, mustBePdfStamped } from "../../models/product-file.ts";
import { nameDisplayable } from "../audience/product-file-json.ts";

import { decideAccess } from "./download-gate.ts";
import { latestMediaLocations, type MediaLocationJson } from "./media-locations.ts";
import { buildGateInput, registerDownload } from "./download-page.ts";
import { load, present, type Loaded } from "./unavailable.ts";

const STREAM_PATH = /^\/s\/([^/.]+)(?:\/([^/.]+))?$/u;
// UrlRedirect::FAKE_VIDEO_URL_GUID_FOR_OBFUSCATION and GUID_GETTER_FROM_S3_URL_REGEX
const FAKE_VIDEO_URL_GUID = "ef64f2fef0d6c776a337050020423fc0";
const GUID_GETTER = /attachments\/(.*)\/original/u;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// WithProductFiles#has_been_transcoded?
async function hasBeenTranscoded(files: DeliveryFile[]): Promise<boolean> {
  for (const { file } of files) {
    if (!isStreamable(file)) continue;
    const completed = await db.transcodedVideo.count({
      where: { streamable_type: "ProductFile", streamable_id: file.id, deleted_at: null, state: "completed" },
    });
    if (completed === 0) return false;
  }
  return true;
}

// UrlRedirect#html5_video_url_and_guid_for_product_file: the real guid goes in the props, a fake one in the url.
async function videoUrlAndGuid(delivery: DeliveryFile, loaded: Loaded): Promise<[string, string]> {
  const fields = delivery.s3 ?? fieldsOf(delivery.file, loaded);
  if (fields === null) throw new HandBackToRails("a video that is not in S3");
  let videoUrl: string;
  try {
    videoUrl = await signedUrl(fields, { isVideo: true });
  } catch (error) {
    if (error instanceof StorageObjectMissing) throw new HandBackToRails("a video missing from storage");
    throw error;
  }
  const guid = GUID_GETTER.exec(videoUrl)?.[1];
  if (guid === undefined) throw new HandBackToRails("a video url without an attachment guid");
  return [videoUrl.replace(guid, () => FAKE_VIDEO_URL_GUID), guid];
}

// UrlRedirect#video_files_playlist
async function videoFilesPlaylist(loaded: Loaded, files: DeliveryFile[], initial: DeliveryFile) {
  const token = loaded.redirect.token ?? "";
  const streamable = files.filter(({ file }) => isStreamable(file));
  const locations = loaded.purchase
    ? await latestMediaLocations(loaded.purchase.id)
    : new Map<bigint, MediaLocationJson>();
  const playlist: Record<string, unknown>[] = [];
  let indexToPlay = 0;
  for (const delivery of streamable) {
    const { file } = delivery;
    const [videoUrl, guid] = await videoUrlAndGuid(delivery, loaded);
    const subtitles = await db.subtitleFile.findMany({
      where: { product_file_id: file.id, deleted_at: null },
      orderBy: { id: "asc" },
    });
    playlist.push({
      sources: [await hlsPlaylistOrSmilPath(token, delivery), videoUrl],
      guid,
      title: nameDisplayable(file, delivery.s3),
      tracks: subtitles.map((subtitle) => ({
        file: `/r/${token}/${encrypt(file.id)}/${encrypt(subtitle.id)}/captions.vtt`,
        label: subtitle.language,
        kind: "captions",
      })),
      external_id: encrypt(file.id),
      latest_media_location:
        file.link_id !== null && file.installment_id === null ? (locations.get(file.id) ?? null) : null,
      content_length: file.duration,
    });
    if (file.id === initial.file.id) indexToPlay = playlist.length - 1;
  }
  return { playlist, indexToPlay };
}

// UrlRedirectsController#stream's lookup: the requested file, else the first video; anything not streamable is a 404.
async function streamedFile(loaded: Loaded, files: DeliveryFile[], requested: string | undefined) {
  const found = requested !== undefined && present(requested) ? findFile(files, requested) : undefined;
  const initial = found ?? files.find(({ file }) => isStreamable(file));
  if (!initial || !isStreamable(initial.file)) throw new RoutingError("Not Found");
  return initial;
}

// UrlRedirectPresenter#stream_page_props
export async function streamPageProps(
  token: string,
  productFileId: string | undefined,
  { loggedInUserId }: { loggedInUserId: bigint | null },
) {
  const loaded = await load(token);
  const files = await aliveProductFiles(loaded);
  const initial = await streamedFile(loaded, files, productFileId);
  const { playlist, indexToPlay } = await videoFilesPlaylist(loaded, files, initial);
  const owner = loaded.product?.user_id ?? null;
  const fileLink =
    initial.file.link_id === null ? null : await db.link.findUnique({ where: { id: initial.file.link_id } });

  return {
    playlist,
    index_to_play: indexToPlay,
    url_redirect_id: encrypt(loaded.redirect.id),
    purchase_id: loaded.purchase ? encrypt(loaded.purchase.id) : null,
    should_show_transcoding_notice:
      loggedInUserId !== null && owner === loggedInUserId && !(await hasBeenTranscoded(files)),
    transcode_on_first_sale: fileLink !== null && LinkFlags.isSet(fileLink.flags, "transcode_videos_on_purchase"),
  };
}

export const STREAM_STATE_KEY = "streamPageProps";

export async function streamFilters(chain: Chain): Promise<FilterOutcome> {
  requireHtml(chain);
  assertFlatQuery(chain.request.queryString);
  const match = STREAM_PATH.exec(chain.request.path);
  if (match === null) throw new RoutingError("Not Found");
  const token = safeDecode(match[1]!);
  const productFileId = match[2] === undefined ? undefined : safeDecode(match[2]);
  const loaded = await load(token);
  // sign_in_mobile_app_viewer needs doorkeeper.
  if (present(queryParam(chain.request, "access_token"))) throw new HandBackToRails("a mobile app token");

  const { gate, viewer } = await buildGateInput(chain, loaded, { destination: "stream", isPoll: false });
  const decision = decideAccess(gate);
  if (decision.kind === "notFound") throw new RoutingError("Not Found");
  if (decision.kind === "redirect") return { halt: { status: 302, location: decision.location, rescued: true } };

  // Built before the write, so a hand-back from the props never follows a counted visit.
  const props = await streamPageProps(loaded.redirect.token ?? token, productFileId, {
    loggedInUserId: viewer?.id ?? null,
  });
  await registerDownload(loaded.redirect, chain);
  return { state: { [STREAM_STATE_KEY]: props } };
}
