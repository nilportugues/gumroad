// Port of app/sidekiq/transfer_dropbox_file_to_s3_worker.rb up to the transfer. `DropboxFile.find` and the guard of
// `DropboxFile#transfer_to_s3` (`cancelled? || deleted? || failed?`) run in Node and finish a file that is no longer in progress or has
// a `deleted_at`; a file in progress is either failed (expired link) or downloaded and uploaded to S3, which hand back to Rails before
// any write, as does an id Rails casts. Golden: __fixtures__/transfer-dropbox-file-to-s3-worker.golden.json
// (scripts/golden/transfer-dropbox-file-to-s3-worker.rb).
import type { DropboxFile } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

const IN_PROGRESS = "in_progress";

export const transferDropboxFileToS3WorkerWith = modelJob({ min: 1 }, async ([dropboxFileId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(dropboxFileId, "DropboxFile.find"));
  const file = await findByIdBang<DropboxFile>("DropboxFile", id);
  // cancelled?, failed? and the state machine's `deleted?` all imply a state other than in_progress; so does a state it does not know.
  if (file.state !== IN_PROGRESS || file.deleted_at !== null) return;

  throw new HandBackToRuby("a file in progress is failed or transferred to S3");
});
export const transferDropboxFileToS3Worker = transferDropboxFileToS3WorkerWith();
