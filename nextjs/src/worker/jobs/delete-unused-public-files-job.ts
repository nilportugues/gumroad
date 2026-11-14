// Port of app/sidekiq/delete_unused_public_files_job.rb: each PublicFile past its scheduled_for_deletion_at is soft-deleted, and its
// blob is purged later unless another attachment still points at it. A batch holding a row that PublicFile's before_validation
// callbacks would fill in, a blob with preview or variant images, or a resource that is not a Link or User is handed back before
// any write of that batch (earlier batches stay deleted, which is safe because the job only reads rows not yet deleted).
// Golden: __fixtures__/delete-unused-public-files-job.golden.json (scripts/golden/delete-unused-public-files-job.rb).
import { Prisma, type ActiveStorageAttachment, type PublicFile } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { purgeBlobLater } from "../../server/models/active-storage-blob.ts";
import {
  PublicFileDeletable,
  PublicFiles,
  resourceKnown,
  unportedCallbackReason,
} from "../../server/models/public-file.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, columnIn, execute, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PUBLIC_FILES = "public_files";
const ATTACHMENTS = "active_storage_attachments";
const BLOBS = "active_storage_blobs";
const VARIANT_RECORDS = "active_storage_variant_records";
const FIND_EACH_BATCH_SIZE = 1_000;

type Row = Record<string, unknown>;
type Preloaded = { attachment: ActiveStorageAttachment; blobId: bigint | null };

const unique = <T>(values: T[]): T[] => [...new Set(values)];

async function attachmentsOf(
  recordType: string,
  name: string,
  recordIds: unknown[],
): Promise<ActiveStorageAttachment[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`active_storage_attachments`.*")} FROM ${table(ATTACHMENTS)} WHERE ${column(ATTACHMENTS, "record_type")} = ${recordType} AND ${column(ATTACHMENTS, "name")} = ${name} AND ${columnIn(ATTACHMENTS, "record_id", recordIds)}`,
  );
  return rows.map((row) => castRow<ActiveStorageAttachment>("ActiveStorageAttachment", row));
}

// `PublicFile.with_attached_file`: the file attachment (a has_one keeps the first row per file), its blob, then the blob's variant
// records, preview image attachment and the variant records' image attachments. A preview or variant image would load more
// blobs, so the batch is handed back; nothing in this job reads them.
async function preload(files: PublicFile[]): Promise<Map<bigint, Preloaded>> {
  const attachments = await attachmentsOf(
    "PublicFile",
    "file",
    files.map((file) => file.id),
  );
  const byFile = new Map<bigint, ActiveStorageAttachment>();
  for (const attachment of attachments)
    if (!byFile.has(attachment.record_id)) byFile.set(attachment.record_id, attachment);

  const loaded = new Set<string>();
  if (byFile.size > 0) {
    const blobIds = unique([...byFile.values()].map((attachment) => attachment.blob_id));
    const blobs = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`active_storage_blobs`.*")} FROM ${table(BLOBS)} WHERE ${columnIn(BLOBS, "id", blobIds)}`,
    );
    for (const blob of blobs) loaded.add(String(blob.id));
    if (blobs.length > 0) {
      const ids = blobs.map((blob) => blob.id);
      const variants = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`active_storage_variant_records`.*")} FROM ${table(VARIANT_RECORDS)} WHERE ${columnIn(VARIANT_RECORDS, "blob_id", ids)}`,
      );
      if ((await attachmentsOf("ActiveStorage::Blob", "preview_image", ids)).length > 0)
        throw new HandBackToRuby("a public file whose blob has a preview image");
      if (variants.length > 0) {
        const images = await attachmentsOf(
          "ActiveStorage::VariantRecord",
          "image",
          variants.map((variant) => variant.id),
        );
        if (images.length > 0) throw new HandBackToRuby("a public file whose blob has variant images");
      }
    }
  }
  return new Map(
    [...byFile].map(([fileId, attachment]) => [
      fileId,
      { attachment, blobId: loaded.has(String(attachment.blob_id)) ? attachment.blob_id : null },
    ]),
  );
}

export const deleteUnusedPublicFilesJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  // The raw `scheduled_for_deletion_at` is Rails' own, left unqualified by the `where` string.
  const where = Prisma.sql`${column(PUBLIC_FILES, "deleted_at")} IS NULL AND (scheduled_for_deletion_at < ${deps.now()})`;
  await findInBatches<Row>(PUBLIC_FILES, where, FIND_EACH_BATCH_SIZE, async (rows) => {
    const files = rows.map((row) => castRow<PublicFile>("PublicFile", row));
    const preloaded = await preload(files);
    for (const file of files) {
      if (!resourceKnown(file)) throw new HandBackToRuby(`a public file of a ${file.resource_type} resource`);
      const reason = unportedCallbackReason(file, preloaded.has(file.id));
      if (reason !== null) throw new HandBackToRuby(reason);
    }
    await deps.watchReplicaLag();

    for (const file of files) {
      const { attachment, blobId } = preloaded.get(file.id) ?? { attachment: null, blobId: null };
      const purgedBlobId = await transaction(async () => {
        const record = PublicFiles.load(file);
        await PublicFileDeletable.markDeletedBang(record, { now: deps.now });
        if (attachment === null || blobId === null) return null;
        // `next if ActiveStorage::Attachment.where(blob_id:).where.not(record: public_file).exists?`
        const [shared] = await selectRows(
          Prisma.sql`SELECT 1 AS one FROM ${table(ATTACHMENTS)} WHERE ${column(ATTACHMENTS, "blob_id")} = ${blobId} AND NOT (${column(ATTACHMENTS, "record_type")} = 'PublicFile' AND ${column(ATTACHMENTS, "record_id")} = ${file.id}) LIMIT 1`,
        );
        if (shared) return null;
        // `file.purge_later`: the attachment row is deleted and its record touched; the blob's PurgeJob is pushed after commit.
        await execute(
          Prisma.sql`DELETE FROM ${table(ATTACHMENTS)} WHERE ${column(ATTACHMENTS, "id")} = ${attachment.id}`,
        );
        await PublicFiles.touch(record, { now: deps.now });
        return blobId;
      });
      if (purgedBlobId !== null) await purgeBlobLater(purgedBlobId, deps.uuid);
    }
  });
});

export const deleteUnusedPublicFilesJob = deleteUnusedPublicFilesJobWith();
