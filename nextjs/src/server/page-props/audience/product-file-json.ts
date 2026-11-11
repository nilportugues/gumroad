// ProductFile#as_json (the files of a post as InstallmentPresenter#props lists them) and the two post-level
// summaries derived from the same rows.
//
// Not ported, refused with NotPortedError: a thumbnail whose variant Rails has not processed yet. A subtitle whose S3 object is missing
// under every Unicode normalization of its key is dropped, as in Ruby.
import { Prisma, type ProductFile } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { signedDownloadUrlForS3KeyAndFilename } from "../../infra/signed-urls.ts";
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
import { numberToHumanSize } from "../../presenters/human-size.ts";
import { NotPortedError } from "../not-ported.ts";
import { productFileThumbnailJson } from "../signed-in/thumbnails.ts";

import { externalId, present } from "./support.ts";

type SubtitleRow = {
  id: bigint | number;
  product_file_id: bigint | number;
  url: string | null;
  language: string | null;
  size: number | null;
};

type BuildRow = {
  product_file_id: bigint | number;
  number: number;
  status: string;
  created_at: Date;
  site_unpacked_at: Date | null;
  user_id: bigint | number;
};

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
async function idsWithRows(
  tableName: string,
  idColumn: string,
  fileIds: bigint[],
  extra: Prisma.Sql,
): Promise<Set<bigint>> {
  const rows = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT DISTINCT ${column(tableName, idColumn)} AS id FROM ${table(tableName)} WHERE ${column(tableName, idColumn)} IN (${Prisma.join(fileIds)}) AND ${extra}`,
  );
  return new Set(rows.map((row) => BigInt(row.id)));
}

const s3DisplayName = (fields: S3Fields | null) =>
  fields === null
    ? null
    : fields.extension.length > 0
      ? fields.filename.slice(0, -fields.extension.length)
      : fields.filename;

// ProductFile#name_displayable
export function nameDisplayable(file: ProductFile, fields: S3Fields | null): string | null {
  if (present(file.display_name)) return file.display_name;
  if (isExternalLink(file)) return file.url;
  return s3DisplayName(fields);
}

// ProductFile#display_extension
export function displayExtension(file: ProductFile, fields: S3Fields | null): string {
  if (isExternalLink(file)) return "URL";
  const s3Extension = fields === null || fields.extension === "" ? "" : fields.extension.slice(1).toUpperCase();
  return s3Extension !== "" ? s3Extension : (file.filetype ?? "").toUpperCase();
}

// `product_build` (has_one) of every file, with the owner of the build's product for the player flag.
async function buildsByFile(fileIds: bigint[]): Promise<Map<bigint, BuildRow>> {
  const rows = await selectRows<BuildRow>(
    Prisma.sql`SELECT ${column("product_builds", "product_file_id")}, ${column("product_builds", "number")}, ${column("product_builds", "status")}, ${column("product_builds", "created_at")}, ${column("product_builds", "site_unpacked_at")}, ${column("links", "user_id")} FROM ${table("product_builds")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_builds", "product_id")} WHERE ${column("product_builds", "product_file_id")} IN (${Prisma.join(fileIds)}) ORDER BY ${column("product_builds", "id")} DESC`,
  );
  // has_one reads the first row by primary key; iterating newest first lets the oldest overwrite.
  return new Map(rows.map((row) => [BigInt(row.product_file_id), row]));
}

// ProductFile#web_build_summary. Time attributes are rendered with ActiveSupport::JSON::Encoding.time_precision = 0.
async function webBuildSummary(build: BuildRow | undefined): Promise<Record<string, unknown> | null> {
  if (build === undefined) return null;
  const live = build.status === "live";
  // ProductBuild#player_enabled? is only asked once the build is live, as `playable?` and `version_history` short-circuit.
  const playerEnabled = live && (await isFeatureEnabled("product_build_player", userActor(String(build.user_id))));
  return {
    number: build.number,
    status: build.status,
    deployed_at: build.created_at.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    playable: playerEnabled && build.site_unpacked_at !== null,
    version_history: playerEnabled,
  };
}

// `alive_subtitle_files` of every file, in id order (the association has no explicit order).
async function aliveSubtitles(fileIds: bigint[]): Promise<Map<bigint, SubtitleRow[]>> {
  const rows = await selectRows<SubtitleRow>(
    Prisma.sql`SELECT ${column("subtitle_files", "id")}, ${column("subtitle_files", "product_file_id")}, ${column("subtitle_files", "url")}, ${column("subtitle_files", "language")}, ${column("subtitle_files", "size")} FROM ${table("subtitle_files")} WHERE ${column("subtitle_files", "product_file_id")} IN (${Prisma.join(fileIds)}) AND ${column("subtitle_files", "deleted_at")} IS NULL ORDER BY ${column("subtitle_files", "id")} ASC`,
  );
  const byFile = new Map<bigint, SubtitleRow[]>();
  for (const row of rows)
    byFile.set(BigInt(row.product_file_id), [...(byFile.get(BigInt(row.product_file_id)) ?? []), row]);
  return byFile;
}

// The `subtitle_files` entries of ProductFile#as_json. `fields` of a subtitle are namespaced by the same owner as its file.
async function subtitleJson(rows: SubtitleRow[], ownerExternalId: string): Promise<Record<string, unknown>[]> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const fields = s3Fields(row.url, ownerExternalId);
      if (fields === null) throw new NotPortedError("ProductFile#as_json for a subtitle file outside S3");
      let signed: string;
      try {
        signed = await signedDownloadUrlForS3KeyAndFilename(fields.key, fields.filename, { isVideo: true });
      } catch (error) {
        // safe_signed_download_url: a subtitle missing under every normalization of its key is dropped.
        if (error instanceof Error && error.name === "NotFound") return null;
        throw error;
      }
      return {
        url: row.url,
        file_name: s3DisplayName(fields),
        extension: fields.extension === "" ? "" : fields.extension.slice(1).toUpperCase(),
        language: row.language,
        file_size: row.size,
        size: numberToHumanSize(row.size),
        signed_url: signed,
        status: { type: "saved" },
      };
    }),
  );
  return entries.filter((entry) => entry !== null);
}

function fileJson(
  file: ProductFile,
  fields: S3Fields | null,
  transcoding: boolean,
  productName: string | null,
  subtitles: Record<string, unknown>[],
  webBuild: Record<string, unknown> | null,
  thumbnail: Record<string, unknown> | null,
): Record<string, unknown> {
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
    web_build: webBuild,
    stream_only: isStreamOnly(file),
    width: streamable ? file.width : null,
    height: streamable ? file.height : null,
    is_transcoding_in_progress: transcoding,
    id: externalId(file.id),
    attached_product_name: productName,
    subtitle_files: subtitles,
    url: file.url,
    isbn: file.isbn,
    thumbnail,
    status: { type: "saved" },
  };
}

// InstallmentPresenter#props' `files`, `stream_only` and `streamable`.
export async function installmentFiles(installmentId: number, sellerId: bigint | number): Promise<InstallmentFiles> {
  const files = await aliveFiles(installmentId);
  if (files.length === 0) return { files: [], streamOnly: false, streamable: false };

  const ids = files.map((file) => file.id);
  const [thumbnails, subtitles, builds, links] = await Promise.all([
    idsWithRows(
      "active_storage_attachments",
      "record_id",
      ids,
      Prisma.sql`${column("active_storage_attachments", "record_type")} = 'ProductFile' AND ${column("active_storage_attachments", "name")} = 'thumbnail'`,
    ),
    aliveSubtitles(ids),
    buildsByFile(ids),
    selectRows<{ id: bigint | number; name: string | null; user_id: bigint | number | null }>(
      Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")}, ${column("links", "user_id")} FROM ${table("links")} WHERE ${column("links", "id")} IN (SELECT ${column("product_files", "link_id")} FROM ${table("product_files")} WHERE ${column("product_files", "id")} IN (${Prisma.join(ids)}))`,
    ),
  ]);
  const linkById = new Map(links.map((link) => [BigInt(link.id), link]));
  const streamableIds = files.filter(isStreamable).map((file) => file.id);
  const processing = streamableIds.length === 0 ? [] : await processingVideos(streamableIds);

  const json = await Promise.all(
    files.map(async (file) => {
      // ProductFile#user is the link's owner when the file belongs to a product, else the post's seller.
      const link = file.link_id === null ? undefined : linkById.get(file.link_id);
      const ownerExternalId = encrypt(link?.user_id ?? sellerId);
      const fields = s3Fields(file.url, ownerExternalId);
      const key = fields?.key ?? null;
      const transcoding = isStreamable(file) && processing.some((video) => video.file === file.id && video.key === key);
      return fileJson(
        file,
        fields,
        transcoding,
        link?.name ?? null,
        await subtitleJson(subtitles.get(file.id) ?? [], ownerExternalId),
        await webBuildSummary(builds.get(file.id)),
        thumbnails.has(file.id) ? await productFileThumbnailJson(file) : null,
      );
    }),
  );

  return { files: json, streamOnly: files.some(isStreamOnly), streamable: files.some(isStreamable) };
}

// `transcoded_videos.alive.processing`, for the product files' own (polymorphic) videos.
async function processingVideos(fileIds: bigint[]): Promise<{ file: bigint; key: string | null }[]> {
  const rows = await selectRows<{ id: bigint | number; key: string | null }>(
    Prisma.sql`SELECT ${column("transcoded_videos", "streamable_id")} AS id, ${column("transcoded_videos", "original_video_key")} AS \`key\` FROM ${table("transcoded_videos")} WHERE ${column("transcoded_videos", "streamable_type")} = 'ProductFile' AND ${column("transcoded_videos", "streamable_id")} IN (${Prisma.join(fileIds)}) AND ${column("transcoded_videos", "deleted_at")} IS NULL AND ${column("transcoded_videos", "state")} = 'processing'`,
  );
  return rows.map((row) => ({ file: BigInt(row.id), key: row.key }));
}
