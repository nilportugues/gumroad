// Port of app/sidekiq/remove_deleted_files_from_s3_job.rb: for each of ProductFile, ProductFilesArchive, SubtitleFile, StampedPdf and
// TranscodedVideo soft-deleted between `max_deletion_age_in_days` and 24 hours ago and not yet removed from the CDN, delete its S3
// objects (the HLS directory listing for a transcoded video) unless an alive row still points at them, then stamp
// `deleted_from_cdn_at` with update_column. A failure on one file is reported and the next file goes on.
// Golden: __fixtures__/remove-deleted-files-from-s3-job.golden.json (scripts/golden/remove-deleted-files-from-s3-job.rb); S3 is
// answered by WebMock there, so the replay compares the keys each DeleteObjects and the prefix each listing asked for.
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { defaultS3Deleter, type S3Deleter } from "../../server/infra/s3-deleter.ts";
import { storageConfig } from "../../server/infra/storage.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, execute, findInBatches, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

// RemoveDeletedFilesFromS3Job::MAX_DELETION_AGE_IN_DAYS
const MAX_DELETION_AGE_IN_DAYS = 3;
const FIND_EACH_BATCH_SIZE = 1_000;
const DELETE_OBJECTS_SLICE = 1_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// A window this wide is not a Ruby Integer Node can judge against the column's range.
const MAX_WINDOW_DAYS = 100_000;
const HLS_KEY = /\/hls\/(?:index\.m3u8)?(?=\n|$)/u; // Ruby's `$` also matches before a newline
const PLAYLIST = "index.m3u8";
// ProductBuild::STORAGE_PREFIX
const BUILD_PREFIX = "builds/";

type Model = { name: string; table: string; s3Scope: boolean };
// The order the job walks them in.
const MODELS: Model[] = [
  { name: "ProductFile", table: "product_files", s3Scope: true },
  { name: "ProductFilesArchive", table: "product_files_archives", s3Scope: true },
  { name: "SubtitleFile", table: "subtitle_files", s3Scope: true },
  { name: "StampedPdf", table: "stamped_pdfs", s3Scope: true },
  { name: "TranscodedVideo", table: "transcoded_videos", s3Scope: false },
];
// TranscodedVideo ignores `product_file_id`, so Rails lists the columns it does read.
const TRANSCODED_VIDEO_COLUMNS = [
  "id",
  "link_id",
  "original_video_key",
  "transcoded_video_key",
  "job_id",
  "state",
  "created_at",
  "updated_at",
  "flags",
  "deleted_from_cdn_at",
  "deleted_at",
  "last_accessed_at",
  "streamable_type",
  "streamable_id",
];

type Row = Record<string, unknown>;

export type RemoveDeletedFilesDeps = {
  s3: S3Deleter;
  // S3_BASE_URL and S3_BUCKET; the storage config when unset
  baseUrl?: string;
  bucket?: string;
  // ErrorNotifier.notify(e) { _1.add_tab(:file, model:, id:, url:) }
  notify: (error: unknown, file: { model: string; id: unknown; url: unknown }) => void;
};

const defaultRemoveDeps: RemoveDeletedFilesDeps = {
  s3: defaultS3Deleter,
  notify: (error, file) => notifyError(error, { file }),
};

// A non-null column of the S3 URL as Ruby's String#split("/") sees it: trailing empty strings are dropped.
function rubySplitSlash(value: string): string[] {
  const parts = value.split("/");
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

// S3Retrievable#s3_key: nil unless the URL starts with S3_BASE_URL, else everything after the bucket.
function s3Key(url: unknown, baseUrl: string): string | null {
  if (typeof url !== "string" || isBlank(url) || !url.startsWith(baseUrl)) return null;
  return rubySplitSlash(url).slice(4).join("/");
}

async function exists(query: Prisma.Sql): Promise<boolean> {
  return (await selectRows(query)).length > 0;
}

const equalsOrNull = (tableName: string, name: string, value: unknown) =>
  value === null || value === undefined
    ? Prisma.sql`${column(tableName, name)} IS NULL`
    : Prisma.sql`${column(tableName, name)} = ${value}`;

// ProductFile#has_alive_duplicate_files? and its siblings.
async function hasAliveDuplicateFiles(model: Model, row: Row, baseUrl: string): Promise<boolean> {
  const alive = (tableName: string, name: string, value: unknown) =>
    exists(
      Prisma.sql`SELECT 1 AS one FROM ${table(tableName)} WHERE ${column(tableName, "deleted_at")} IS NULL AND ${equalsOrNull(tableName, name, value)} LIMIT 1`,
    );
  switch (model.name) {
    case "ProductFile": {
      if (await alive("product_files", "url", row.url)) return true;
      // owned_by_product_build?: a live build of a product that is not deleted still owns the object.
      const key = s3Key(row.url, baseUrl);
      if (!key?.startsWith(BUILD_PREFIX)) return false;
      return exists(
        Prisma.sql`SELECT 1 AS one FROM ${table("product_builds")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("product_builds", "product_id")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("product_builds", "storage_key")} = ${key} LIMIT 1`,
      );
    }
    case "SubtitleFile":
      return alive("subtitle_files", "url", row.url);
    case "TranscodedVideo":
      return alive("transcoded_videos", "transcoded_video_key", row.transcoded_video_key);
    default:
      return false;
  }
}

// The listed keys of the HLS directory, without the ones in sub directories.
async function transcodedVideoKeys(key: unknown, bucket: string, s3: S3Deleter): Promise<string[]> {
  if (typeof key !== "string" || !HLS_KEY.test(key)) return [];
  const hlsDir = key.endsWith(PLAYLIST) ? key.slice(0, -PLAYLIST.length) : key;
  // `delete_prefix(hls_dir).include?("/")` drops keys in sub directories.
  return (await s3.listKeys(bucket, hlsDir)).filter(
    (listed) => !(listed.startsWith(hlsDir) ? listed.slice(hlsDir.length) : listed).includes("/"),
  );
}

async function removeRecordFiles(
  model: Model,
  row: Row,
  baseUrl: string,
  bucket: string,
  deps: RemoveDeletedFilesDeps,
  now: Date,
) {
  const keys = (
    model.name === "TranscodedVideo"
      ? await transcodedVideoKeys(row.transcoded_video_key, bucket, deps.s3)
      : [s3Key(row.url, baseUrl)]
  ).filter((key): key is string => key !== null && !isBlank(key));

  for (let start = 0; start < keys.length; start += DELETE_OBJECTS_SLICE)
    await deps.s3.deleteObjects(bucket, keys.slice(start, start + DELETE_OBJECTS_SLICE));

  // `update_column(:deleted_from_cdn_at, Time.current)`: transcoded_videos.deleted_from_cdn_at is datetime(0).
  const stamp = model.name === "TranscodedVideo" ? new Date(Math.floor(now.getTime() / 1000) * 1000) : now;
  await execute(
    Prisma.sql`UPDATE ${table(model.table)} SET ${column(model.table, "deleted_from_cdn_at")} = ${stamp} WHERE ${column(model.table, "id")} = ${row.id}`,
  );
}

async function removeRecordsFiles(
  model: Model,
  from: Date,
  to: Date,
  baseUrl: string,
  bucket: string,
  deps: RemoveDeletedFilesDeps,
  now: Date,
) {
  const deletedAt = column(model.table, "deleted_at");
  const window =
    from.getTime() === to.getTime()
      ? Prisma.sql`${deletedAt} = ${from}`
      : Prisma.sql`${deletedAt} BETWEEN ${from} AND ${to}`;
  const conditions = [
    window,
    ...(model.s3Scope ? [Prisma.sql`(url LIKE ${`${baseUrl}%`})`] : []),
    Prisma.sql`${deletedAt} IS NOT NULL`,
    Prisma.sql`${column(model.table, "deleted_from_cdn_at")} IS NULL`,
  ];
  const select =
    model.name === "TranscodedVideo"
      ? Prisma.raw(TRANSCODED_VIDEO_COLUMNS.map((name) => `${quoteName(model.table)}.${quoteName(name)}`).join(", "))
      : null;
  await findInBatches<Row>(
    model.table,
    Prisma.join(conditions, " AND "),
    FIND_EACH_BATCH_SIZE,
    async (rows) => {
      for (const row of rows) {
        try {
          if (await hasAliveDuplicateFiles(model, row, baseUrl)) continue;
          await removeRecordFiles(model, row, baseUrl, bucket, deps, now);
        } catch (error) {
          if (error instanceof HandBackToRuby) throw error;
          deps.notify(error, { model: model.name, id: row.id, url: "url" in row ? row.url : null });
        }
      }
    },
    select,
  );
}

export const removeDeletedFilesFromS3JobWith = (overrides: Partial<JobDeps> & Partial<RemoveDeletedFilesDeps> = {}) => {
  const { s3, notify, baseUrl, bucket, ...jobDeps } = overrides;
  const deps: RemoveDeletedFilesDeps = { ...defaultRemoveDeps, ...(s3 && { s3 }), ...(notify && { notify }) };
  return modelJob({ min: 0, max: 1 }, async ([windowArg = MAX_DELETION_AGE_IN_DAYS], job) => {
    if (typeof windowArg !== "number" || !Number.isInteger(windowArg) || Math.abs(windowArg) > MAX_WINDOW_DAYS)
      throw new HandBackToRuby(`max_deletion_age_in_days ${JSON.stringify(windowArg)} is not a plain Integer`);
    const now = job.now();
    const from = new Date(now.getTime() - windowArg * DAY_MS);
    const to = new Date(now.getTime() - 24 * HOUR_MS);
    const config = storageConfig();
    for (const model of MODELS)
      await removeRecordsFiles(model, from, to, baseUrl ?? config.s3BaseUrl, bucket ?? config.s3Bucket, deps, now);
  })(jobDeps);
};

export const removeDeletedFilesFromS3Job = removeDeletedFilesFromS3JobWith();
