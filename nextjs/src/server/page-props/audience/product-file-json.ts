// ProductFile#as_json (the files of a post as InstallmentPresenter#props lists them) and the two post-level
// summaries derived from the same rows.
//
// Not ported, each refused with NotPortedError: a streamable or image file with a thumbnail attachment
// (ActiveStorage URL and signed id), a file with subtitle files (signed download URLs) and a file owned by a web build.
import { Prisma, type ProductFile } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import {
  ProductFileFlags,
  canDisableDownloads,
  isEpub,
  isExternalLink,
  isPdf,
  isStreamOnly,
  isStreamable,
  s3Fields,
  type S3Fields,
} from "../../models/product-file.ts";
import { castRow, column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { externalId, present } from "./support.ts";

// ProductFile::BROWSER_RENDERABLE_IMAGE_FILETYPES
const BROWSER_RENDERABLE_IMAGE_FILETYPES = ["png", "jpg", "jpeg", "gif", "webp"];

export type InstallmentFiles = {
  files: Record<string, unknown>[];
  // Installment#has_stream_only_files? and Installment#streamable?
  streamOnly: boolean;
  streamable: boolean;
};

// `alive_product_files`: `product_files.alive.in_order`.
async function aliveFiles(installmentId: number): Promise<ProductFile[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${table("product_files")}.* FROM ${table("product_files")} WHERE ${column("product_files", "installment_id")} = ${installmentId} AND ${column("product_files", "deleted_at")} IS NULL ORDER BY ${column("product_files", "position")} ASC`,
  );
  return rows.map((row) => castRow<ProductFile>("ProductFile", row));
}

// The ids among `fileIds` that have a row in `tableName`, filtered by `extra`.
async function idsWithRows(tableName: string, idColumn: string, fileIds: bigint[], extra: Prisma.Sql): Promise<Set<bigint>> {
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT DISTINCT ${column(tableName, idColumn)} AS id FROM ${table(tableName)} WHERE ${column(tableName, idColumn)} IN (${Prisma.join(fileIds)}) AND ${extra}`,
  );
  return new Set(rows.map((row) => BigInt(row.id)));
}

const s3DisplayName = (fields: S3Fields | null) => (fields === null ? null : fields.extension.length > 0 ? fields.filename.slice(0, -fields.extension.length) : fields.filename);

// ProductFile#name_displayable
function nameDisplayable(file: ProductFile, fields: S3Fields | null): string | null {
  if (present(file.display_name)) return file.display_name;
  if (isExternalLink(file)) return file.url;
  return s3DisplayName(fields);
}

// ProductFile#display_extension
function displayExtension(file: ProductFile, fields: S3Fields | null): string {
  if (isExternalLink(file)) return "URL";
  const s3Extension = fields === null || fields.extension === "" ? "" : fields.extension.slice(1).toUpperCase();
  return s3Extension !== "" ? s3Extension : (file.filetype ?? "").toUpperCase();
}

function fileJson(file: ProductFile, fields: S3Fields | null, transcoding: boolean, productName: string | null): Record<string, unknown> {
  const streamable = isStreamable(file);
  const name = nameDisplayable(file, fields);
  return {
    file_name: name,
    display_name: name,
    description: file.description,
    extension: displayExtension(file, fields),
    file_size: file.size === null ? null : Number(file.size),
    pagelength: isEpub(file) ? null : file.pagelength,
    duration: file.duration,
    is_pdf: isPdf(file),
    pdf_stamp_enabled: ProductFileFlags.isSet(file.flags, "pdf_stamp_enabled"),
    hide_kindle_and_read_buttons: ProductFileFlags.isSet(file.flags, "hide_kindle_and_read_buttons"),
    is_streamable: streamable,
    can_disable_downloads: canDisableDownloads(file),
    web_build: null,
    stream_only: isStreamOnly(file),
    width: streamable ? file.width : null,
    height: streamable ? file.height : null,
    is_transcoding_in_progress: transcoding,
    id: externalId(file.id),
    attached_product_name: productName,
    subtitle_files: [],
    url: file.url,
    isbn: file.isbn,
    thumbnail: null,
    status: { type: "saved" },
  };
}

// InstallmentPresenter#props' `files`, `stream_only` and `streamable`.
export async function installmentFiles(installmentId: number, sellerId: bigint | number): Promise<InstallmentFiles> {
  const files = await aliveFiles(installmentId);
  if (files.length === 0) return { files: [], streamOnly: false, streamable: false };

  const ids = files.map((file) => file.id);
  const [thumbnails, subtitles, builds, links] = await Promise.all([
    idsWithRows("active_storage_attachments", "record_id", ids, Prisma.sql`${column("active_storage_attachments", "record_type")} = 'ProductFile' AND ${column("active_storage_attachments", "name")} = 'thumbnail'`),
    idsWithRows("subtitle_files", "product_file_id", ids, Prisma.sql`${column("subtitle_files", "deleted_at")} IS NULL`),
    idsWithRows("product_builds", "product_file_id", ids, Prisma.sql`1 = 1`),
    selectRows<{ id: bigint | number; name: string | null; user_id: bigint | number | null }>(
      Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} IN (SELECT ${column("product_files", "link_id")} FROM ${table("product_files")} WHERE ${column("product_files", "id")} IN (${Prisma.join(ids)}))`,
    ),
  ]);
  const linkById = new Map(links.map((link) => [BigInt(link.id), link]));
  const streamableIds = files.filter(isStreamable).map((file) => file.id);
  const processing = streamableIds.length === 0 ? [] : await processingVideos(streamableIds);

  const json = files.map((file) => {
    if (builds.has(file.id)) throw new NotPortedError("ProductFile#as_json for a file owned by a web build");
    if (subtitles.has(file.id)) throw new NotPortedError("ProductFile#as_json for a file with subtitle files");
    if (thumbnails.has(file.id) && (isStreamable(file) || BROWSER_RENDERABLE_IMAGE_FILETYPES.includes(file.filetype ?? ""))) {
      throw new NotPortedError("ProductFile#as_json for a file with a thumbnail");
    }
    // ProductFile#user is the link's owner when the file belongs to a product, else the post's seller.
    const link = file.link_id === null ? undefined : linkById.get(file.link_id);
    const ownerExternalId = encrypt(link?.user_id ?? sellerId);
    const fields = s3Fields(file.url, ownerExternalId);
    const key = fields?.key ?? null;
    const transcoding = isStreamable(file) && processing.some((video) => video.file === file.id && video.key === key);
    return fileJson(file, fields, transcoding, link?.name ?? null);
  });

  return { files: json, streamOnly: files.some(isStreamOnly), streamable: files.some(isStreamable) };
}

// `transcoded_videos.alive.processing`, for the product files' own (polymorphic) videos.
async function processingVideos(fileIds: bigint[]): Promise<{ file: bigint; key: string | null }[]> {
  const rows = await selectRows<{ id: bigint | number; key: string | null }>(
    Prisma.sql`SELECT ${column("transcoded_videos", "streamable_id")} AS id, ${column("transcoded_videos", "original_video_key")} AS \`key\` FROM ${table("transcoded_videos")} WHERE ${column("transcoded_videos", "streamable_type")} = 'ProductFile' AND ${column("transcoded_videos", "streamable_id")} IN (${Prisma.join(fileIds)}) AND ${column("transcoded_videos", "deleted_at")} IS NULL AND ${column("transcoded_videos", "state")} = 'processing'`,
  );
  return rows.map((row) => ({ file: BigInt(row.id), key: row.key }));
}
