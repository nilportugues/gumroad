// Port of app/sidekiq/record_product_file_missing_from_storage_job.rb: a deleted file, one that is not under the S3 base url, one whose
// analysis completed, one already marked deleted from the CDN and one younger than the 3-day upload grace period are left alone. A
// file past those has its object looked up with a HEAD: found leaves it alone, a 404 marks it (`update_column(:deleted_from_cdn_at)`,
// no callbacks and no `updated_at`), and any other answer hands the job back before the write. Only a printable-ASCII key is looked up
// here: other keys have Unicode variants Rails probes first, and an empty key makes the SDK refuse the request, so those hand back
// right after the read.
// Golden: __fixtures__/record-product-file-missing-from-storage-job.golden.json
// (scripts/golden/record-product-file-missing-from-storage-job.rb); the two storage lookups were replaced there by recorders.
import { Prisma, type ProductFile } from "@prisma/client";

import { storageConfig } from "../../server/infra/storage.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { defaultS3Reader, type S3Reader } from "../../server/mail/s3-object.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, execute, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const PRODUCT_FILES = "product_files";
// ProductFile has_flags 3 => :analyze_completed
const ANALYZE_COMPLETED = 1n << 2n;
const UPLOAD_GRACE_PERIOD = { days: 3 };
// A key with no character that has a Unicode normalization variant.
const PRINTABLE_ASCII_KEY = /^[\x20-\x7e]+$/u;
// `s3_url.split("/")[4..-1]` drops the scheme, the empty segment, the host and the bucket.
const KEY_START = 4;
const NOT_FOUND = 404;

export type RecordProductFileStorage = { s3: S3Reader; bucket: () => string };

// `s3_url.split("/")[4..-1].join("/")`; String#split drops trailing empty strings.
function s3Key(url: string): string {
  const parts = url.split("/");
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts.slice(KEY_START).join("/");
}

// `file.s3_object.exists?`; null for an answer that is neither found nor not found.
async function objectExists(key: string, storage: Partial<RecordProductFileStorage>): Promise<boolean | null> {
  const reader = storage.s3 ?? defaultS3Reader;
  const bucket = (storage.bucket ?? (() => storageConfig().s3Bucket))();
  try {
    await reader.contentLength(bucket, key);
    return true;
  } catch (error) {
    return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === NOT_FOUND
      ? false
      : null;
  }
}

export const recordProductFileMissingFromStorageJobWith = (
  jobDeps: Partial<JobDeps> = {},
  storage: Partial<RecordProductFileStorage> = {},
) =>
  modelJob({ min: 1 }, async ([productFileId], deps) => {
    const id =
      productFileId === null ? null : await beforeSideEffects(() => recordIdFrom(productFileId, "ProductFile.find_by"));
    // `ProductFile.alive.find_by(id:)`
    const idCondition =
      id === null
        ? Prisma.sql`${column(PRODUCT_FILES, "id")} IS NULL`
        : Prisma.sql`${column(PRODUCT_FILES, "id")} = ${id}`;
    const [row] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PRODUCT_FILES)}.*`)} FROM ${table(PRODUCT_FILES)} WHERE ${column(PRODUCT_FILES, "deleted_at")} IS NULL AND ${idCondition} LIMIT 1`,
    );
    if (row === undefined) return;
    const file = castRow<ProductFile>("ProductFile", row);

    // `eligible?`: s3? (a url under S3_BASE_URL), !analyze_completed?, !deleted_from_cdn?, created before the grace period ends
    if (!file.url?.startsWith(storageConfig().s3BaseUrl)) return;
    if ((BigInt(file.flags) & ANALYZE_COMPLETED) !== 0n) return;
    if (file.deleted_from_cdn_at !== null) return;
    if (!(file.created_at <= ago(UPLOAD_GRACE_PERIOD, deps.now()))) return;

    const key = s3Key(file.url);
    if (!PRINTABLE_ASCII_KEY.test(key))
      throw new HandBackToRuby("the Unicode key variants of a product file's storage key are not ported");
    const exists = await objectExists(key, storage);
    if (exists === null)
      throw new HandBackToRuby("the storage answered a HEAD with an error Rails reports differently");
    if (exists) return;

    // `mark_deleted_from_cdn`: `update_column(:deleted_from_cdn_at, Time.current)`
    await execute(
      Prisma.sql`UPDATE ${table(PRODUCT_FILES)} SET ${column(PRODUCT_FILES, "deleted_from_cdn_at")} = ${deps.now()} WHERE ${column(PRODUCT_FILES, "id")} = ${file.id}`,
    );
  })(jobDeps);

export const recordProductFileMissingFromStorageJob = recordProductFileMissingFromStorageJobWith();
