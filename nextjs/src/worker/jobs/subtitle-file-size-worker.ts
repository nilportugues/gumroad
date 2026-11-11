// Port of app/sidekiq/subtitle_file_size_worker.rb and SubtitleFile#calculate_size: the size of a subtitle file is read from its
// S3 object with a HEAD request and saved on the row. The HEAD runs before the save's transaction, as in Rails, so a missing object
// raises Ruby's `Aws::S3::Errors::NotFound` (or `Forbidden`) with no write. Any other storage answer, which the AWS SDKs retry in
// different ways, and a size past the 4-byte integer column, which Rails fails on inside the save, hand back before any write.
// Golden: __fixtures__/subtitle-file-size-worker.golden.json (scripts/golden/subtitle-file-size-worker.rb).
import type { SubtitleFile } from "@prisma/client";

import { storageConfig } from "../../server/infra/storage.ts";
import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { defaultS3Reader, type S3Reader } from "../../server/mail/s3-object.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { loadSubtitleFile, SubtitleFiles } from "../../server/models/subtitle-file.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const MAX_INTEGER_COLUMN = 2 ** 31 - 1;
// Where `s3_key` starts: `url.split("/")[4..]` drops the scheme, the empty segment, the host and the bucket.
const KEY_START = 4;

export type SubtitleFileSizeDeps = { s3: S3Reader; baseUrl: () => string; bucket: () => string };

class RubyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// String#split("/") drops trailing empty strings.
function s3Key(url: string): string {
  const parts = url.split("/");
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts.slice(KEY_START).join("/");
}

// The SDK's error for the status of a HEAD with no body, named after the Ruby class aws-sdk-s3 raises.
function storageError(error: unknown): Error {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 404) return new RubyError("Aws::S3::Errors::NotFound", "Aws::S3::Errors::NotFound");
  if (status === 403) return new RubyError("Aws::S3::Errors::Forbidden", "Aws::S3::Errors::Forbidden");
  return new HandBackToRuby("the storage answered a HEAD with an error Rails reports differently");
}

export const subtitleFileSizeWorkerWith = (deps: Partial<JobDeps> = {}, storage: Partial<SubtitleFileSizeDeps> = {}) =>
  modelJob({ min: 1 }, async ([subtitleFileId], jobDeps) => {
    // `find_by(id: nil)` is a query for NULL that finds nothing.
    const id =
      subtitleFileId === null
        ? null
        : await beforeSideEffects(() => recordIdFrom(subtitleFileId, "SubtitleFile.find_by"));
    const row = await findOneBy<SubtitleFile>("SubtitleFile", "id", id, true);
    if (row === null) return;

    const baseUrl = (storage.baseUrl ?? (() => storageConfig().s3BaseUrl))();
    const url = row.url;
    // `s3_object` is nil for a url that is blank or outside the bucket, and `nil.content_length` raises.
    if (url === null || isBlank(url) || !url.startsWith(baseUrl))
      throw new RubyError("NoMethodError", "undefined method 'content_length' for nil");

    const reader = storage.s3 ?? defaultS3Reader;
    const bucket = (storage.bucket ?? (() => storageConfig().s3Bucket))();
    let size: number | undefined;
    try {
      size = await reader.contentLength(bucket, s3Key(url));
    } catch (error) {
      throw storageError(error);
    }
    if (size !== undefined && size > MAX_INTEGER_COLUMN)
      throw new HandBackToRuby("the size does not fit the size column");

    const file = loadSubtitleFile(row);
    file.assign({ size: size ?? null });
    await SubtitleFiles.saveBang(file, { now: jobDeps.now });
  })(deps);

export const subtitleFileSizeWorker = subtitleFileSizeWorkerWith();
