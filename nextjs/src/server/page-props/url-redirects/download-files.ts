// UrlRedirectPresenter#download_attributes and #map_file: the `content_items` of the download page for a redirect whose files are the
// product's own. What the port does not prove goes to Rails before any write: a file with a thumbnail, a promoted web build, an EPUB's
// reading location, a stamped PDF (aliveProductFiles), a purchased variant, rich content, a commission's files.
import type { ProductFile, User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import {
  aliveProductFiles,
  fieldsOf,
  isFileDownloadable,
  signedUrl,
  StorageObjectMissing,
  type DeliveryFile,
} from "../../controllers/url-redirects/files.ts";
import { cgiEscape } from "../../infra/signed-urls.ts";
import {
  browserReadable,
  canSendToKindle,
  isEpub,
  isExternalLink,
  isListenable,
  isStreamable,
  isStreamOnly,
  ProductFileFlags,
  s3Fields,
} from "../../models/product-file.ts";
import { imagePath } from "../../erb/home-layout.ts";
import { domainConfig } from "../domain.ts";
import { displayExtension, nameDisplayable, s3DisplayName } from "../audience/product-file-json.ts";

import { latestMediaLocations } from "./media-locations.ts";
import type { Loaded } from "./unavailable.ts";

// ProductFile::BROWSER_RENDERABLE_IMAGE_FILETYPES
const BROWSER_RENDERABLE_IMAGE_FILETYPES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const KINDLE_ICON = "white-15.png";

const browserRenderableImage = (file: ProductFile) => BROWSER_RENDERABLE_IMAGE_FILETYPES.has(file.filetype ?? "");

type SubtitleRow = { id: bigint; url: string | null; language: string | null; size: number | null };

// The files whose map_file output depends on something Node does not read.
async function assertNothingUnproven(files: DeliveryFile[]): Promise<void> {
  if (files.length === 0) return;
  const ids = files.map(({ file }) => file.id);
  if ((await db.productBuild.count({ where: { product_file_id: { in: ids } } })) > 0)
    throw new HandBackToRails("a file that belongs to a web build");
  const thumbnails = await db.activeStorageAttachment.count({
    where: { record_type: "ProductFile", record_id: { in: ids }, name: "thumbnail" },
  });
  if (thumbnails > 0) throw new HandBackToRails("a file with a thumbnail");
}

async function subtitleItems(
  token: string,
  delivery: DeliveryFile,
  rows: SubtitleRow[],
  ownerExternalId: string | null,
) {
  const fileId = encrypt(delivery.file.id);
  return Promise.all(
    rows.map(async (row) => {
      const fields = s3Fields(row.url, ownerExternalId);
      if (fields === null) throw new HandBackToRails("a subtitle file outside S3");
      let signed: string;
      try {
        signed = await signedUrl(fields, { isVideo: true });
      } catch (error) {
        if (error instanceof StorageObjectMissing) throw new HandBackToRails("a subtitle file missing from storage");
        throw error;
      }
      const subtitleId = encrypt(row.id);
      return {
        url: row.url,
        file_name: s3DisplayName(fields),
        extension: fields.extension === "" ? "" : fields.extension.slice(1).toUpperCase(),
        language: row.language,
        file_size: row.size,
        download_url: `/r/${token}/${fileId}/${subtitleId}`,
        signed_url: signed,
        vtt_url: `/r/${token}/${fileId}/${subtitleId}/captions.vtt`,
      };
    }),
  );
}

export async function contentItems(loaded: Loaded, loggedInUser: User | null): Promise<unknown[]> {
  const { redirect, purchase, product } = loaded;
  if (product === null) return [];
  const token = redirect.token ?? "";
  if (
    purchase &&
    (await db.commission.count({
      where: { OR: [{ deposit_purchase_id: purchase.id }, { completion_purchase_id: purchase.id }] },
    })) > 0
  )
    throw new HandBackToRails("a commission");
  const files = await aliveProductFiles(loaded);
  await assertNothingUnproven(files);
  if (files.length === 0) return [];

  const config = domainConfig(process.env);
  const ids = files.map(({ file }) => file.id);
  const locations = purchase ? await latestMediaLocations(purchase.id) : new Map();
  const subtitleRows = await db.subtitleFile.findMany({
    where: { product_file_id: { in: ids }, deleted_at: null },
    orderBy: { id: "asc" },
  });
  const ownerExternalId = product.user_id === null ? null : encrypt(product.user_id);

  const mapFile = async (delivery: DeliveryFile) => {
    const { file, s3 } = delivery;
    const id = encrypt(file.id);
    const downloadable = await isFileDownloadable(loaded, delivery);
    const downloadUrl = downloadable ? `/r/${token}/product_files?product_file_ids%5B%5D=${cgiEscape(id)}` : null;
    const hideButtons = ProductFileFlags.isSet(file.flags, "hide_kindle_and_read_buttons");
    const media = locations.get(file.id) ?? null;
    if (media !== null && isEpub(file)) throw new HandBackToRails("the reading location of an EPUB");
    const compatible =
      media !== null &&
      (isListenable(file) || isStreamable(file)
        ? media.unit === "seconds"
        : browserReadable(file)
          ? media.unit === "page_number"
          : false);
    const subtitles = subtitleRows.filter((row) => row.product_file_id === file.id);

    return {
      type: "file",
      file_name: nameDisplayable(file, s3),
      description: file.description,
      extension: displayExtension(file, s3),
      web_build: null,
      file_size: file.size === null ? null : Number(file.size),
      pagelength: isEpub(file) ? null : file.pagelength,
      duration: file.duration,
      id,
      download_url: downloadUrl,
      archivable: !isExternalLink(file) && !isStreamOnly(file),
      view_url: browserRenderableImage(file) ? downloadUrl : null,
      stream_url: isStreamable(file) ? `/s/${token}/${id}` : null,
      kindle_data:
        canSendToKindle(file) && !hideButtons
          ? { email: loggedInUser?.kindle_email ?? null, icon_url: imagePath(config, KINDLE_ICON) }
          : null,
      latest_media_location: compatible ? media : null,
      content_length: isListenable(file) || isStreamable(file) ? file.duration : isEpub(file) ? 100 : file.pagelength,
      isbn: file.isbn,
      read_url: browserReadable(file) && (!hideButtons || isStreamOnly(file)) ? `/read/${token}/${id}` : null,
      external_link_url: isExternalLink(file) ? file.url : null,
      subtitle_files: await subtitleItems(token, delivery, subtitles as SubtitleRow[], ownerExternalId),
      pdf_stamp_enabled: ProductFileFlags.isSet(file.flags, "pdf_stamp_enabled"),
      processing: false,
      thumbnail_url: null,
      width: isStreamable(file) ? file.width : null,
      height: isStreamable(file) ? file.height : null,
    };
  };

  // A file in a folder that is gone is listed at the top level, as ProductFile#external_folder_id answers nil for it.
  const folderIds = [...new Set(files.flatMap(({ file }) => file.folder_id ?? []))];
  const folderRows = await db.productFolder.findMany({ where: { id: { in: folderIds } } });
  const aliveFolders = new Set(folderRows.filter((row) => row.deleted_at === null).map((row) => row.id));
  const listedFolders = folderRows
    .filter((row) => row.deleted_at === null && row.product_id === product.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || Number(a.id - b.id));

  const items: unknown[] = [];
  for (const folder of listedFolders) {
    const children = [];
    for (const delivery of files) if (delivery.file.folder_id === folder.id) children.push(await mapFile(delivery));
    items.push({ type: "folder", id: encrypt(folder.id), name: folder.name, children });
  }
  for (const delivery of files)
    if (delivery.file.folder_id === null || !aliveFolders.has(delivery.file.folder_id))
      items.push(await mapFile(delivery));
  return items;
}
