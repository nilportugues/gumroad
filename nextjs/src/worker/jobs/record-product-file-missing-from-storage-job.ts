// Port of the guards of app/sidekiq/record_product_file_missing_from_storage_job.rb: a deleted file, one that is not under the S3 base
// url, one whose analysis completed, one already marked deleted from the CDN and one younger than the 3-day upload grace period are
// left alone. A file past those goes on to S3 (the Unicode-variant lookup, then the object's HEAD) and, if it is missing, a write;
// that stays with Rails: the job is handed back right after the read.
// Golden: __fixtures__/record-product-file-missing-from-storage-job.golden.json
// (scripts/golden/record-product-file-missing-from-storage-job.rb); the two storage lookups were replaced there.
import { Prisma, type ProductFile } from "@prisma/client";

import { storageConfig } from "../../server/infra/storage.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PRODUCT_FILES = "product_files";
// ProductFile has_flags 3 => :analyze_completed
const ANALYZE_COMPLETED = 1n << 2n;
const UPLOAD_GRACE_PERIOD = { days: 3 };

export const recordProductFileMissingFromStorageJobWith = modelJob({ min: 1 }, async ([productFileId], deps) => {
  const key =
    productFileId === null ? null : await beforeSideEffects(() => recordIdFrom(productFileId, "ProductFile.find_by"));
  // `ProductFile.alive.find_by(id:)`
  const idCondition =
    key === null
      ? Prisma.sql`${column(PRODUCT_FILES, "id")} IS NULL`
      : Prisma.sql`${column(PRODUCT_FILES, "id")} = ${key}`;
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

  throw new HandBackToRuby("the S3 lookups of a product file are not ported");
});

export const recordProductFileMissingFromStorageJob = recordProductFileMissingFromStorageJobWith();
