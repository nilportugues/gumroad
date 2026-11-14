// app/models/dropbox_file.rb: the rows DropboxFilesController creates and cancels. The transfer to S3
// (TransferDropboxFileToS3Worker#perform) stays with Sidekiq, which this model only schedules.
import { Prisma, type DropboxFile } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { rubyToI } from "../mail/mailer-info.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { truncateToSeconds } from "./concerns/ruby-time.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const DROPBOX_FILES = "dropbox_files";
// DropboxFile#schedule_dropbox_file_analyze: `perform_in(5.seconds, id)`
const TRANSFER_DELAY_SECONDS = 5;
// Dropbox direct file links expire after 4 hours.
const LINK_VALID_FOR_MS = 4 * 3_600_000;

export const DropboxFiles = defineModel<DropboxFile>({
  rubyClass: "DropboxFile",
  prismaModel: "DropboxFile",
  delegate: (tx) => tx.dropboxFile as never,
  validations: [validatesPresenceOf(["dropbox_url"])],
  afterCommit: [
    {
      name: "schedule_dropbox_file_analyze",
      on: "create",
      async run(record) {
        await performAsync("TransferDropboxFileToS3Worker", [Number(record.get("id"))], { delaySeconds: TRANSFER_DELAY_SECONDS });
      },
    },
  ],
});

export type RawFileInfo = { name?: unknown; bytes?: unknown; link?: unknown };

// DropboxFile.clean_file_info, as the JSON text of `json_data`
function fileInfoJson(raw: RawFileInfo): string {
  const bytes = typeof raw.bytes === "number" ? Math.trunc(raw.bytes) : typeof raw.bytes === "string" ? rubyToI(raw.bytes) : 0;
  return JSON.stringify({ file_name: raw.name ?? null, file_size: bytes });
}

// DropboxFile.create_with_file_info, then `user =`, `link =` and the second `save!` of the controller, as one INSERT.
export async function createDropboxFile(raw: RawFileInfo, userId: number, linkId: number | null, now: () => Date = () => new Date()) {
  const created = await DropboxFiles.createBang(
    {
      dropbox_url: (raw.link ?? null) as string | null,
      expires_at: truncateToSeconds(new Date(now().getTime() + LINK_VALID_FOR_MS)),
      json_data: fileInfoJson(raw),
      state: "in_progress",
      user_id: userId,
      link_id: linkId,
    },
    { now },
  );
  return created;
}

export async function findDropboxFileForUser(userId: number | bigint, externalId: string): Promise<ModelRecord<DropboxFile> | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`dropbox_files`.*")} FROM ${table(DROPBOX_FILES)} WHERE ${column(DROPBOX_FILES, "user_id")} = ${userId} AND ${column(DROPBOX_FILES, "id")} = ${id} LIMIT 1`);
  return row ? DropboxFiles.load(castRow<DropboxFile>("DropboxFile", row)) : null;
}

// `scope :available` (no product) and `scope :available_for_product`
export async function listDropboxFiles(userId: number | bigint, linkId: number | bigint | null): Promise<DropboxFile[]> {
  const where =
    linkId === null
      ? Prisma.sql`${column(DROPBOX_FILES, "user_id")} = ${userId} AND ${column(DROPBOX_FILES, "deleted_at")} IS NULL AND ${column(DROPBOX_FILES, "link_id")} IS NULL AND ${column(DROPBOX_FILES, "product_file_id")} IS NULL`
      : Prisma.sql`${column(DROPBOX_FILES, "link_id")} = ${linkId} AND ${column(DROPBOX_FILES, "deleted_at")} IS NULL AND ${column(DROPBOX_FILES, "product_file_id")} IS NULL`;
  const rows = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`dropbox_files`.*")} FROM ${table(DROPBOX_FILES)} WHERE ${where} ORDER BY ${column(DROPBOX_FILES, "id")} ASC`);
  return rows.map((row) => castRow<DropboxFile>("DropboxFile", row));
}

// state_machine events: mark_deleted (successfully_uploaded) and mark_cancelled (in_progress), each followed by
// `update_deleted_at!` (after_transition to cancelled, failed or deleted).
export async function transitionDropboxFile(record: ModelRecord<DropboxFile>, state: "deleted" | "cancelled", now: () => Date = () => new Date()): Promise<void> {
  await DropboxFiles.updateBang(record, { state }, { now });
  await DropboxFiles.updateBang(record, { deleted_at: truncateToSeconds(now()) }, { now });
}

// DropboxFile#as_json. `expires_at` is ActiveSupport's time JSON (precision 0).
export function dropboxFileJson(record: DropboxFile, externals: { userExternalId: string | null; linkExternalId: string | null }) {
  const info = record.json_data === null ? {} : (JSON.parse(record.json_data) as { file_name?: unknown; file_size?: unknown });
  return {
    dropbox_url: record.dropbox_url,
    external_id: encrypt(record.id),
    s3_url: record.s3_url,
    user_id: externals.userExternalId,
    product_file_id: record.product_file_id === null ? null : encrypt(record.product_file_id),
    link_id: externals.linkExternalId,
    expires_at: record.expires_at === null ? null : record.expires_at.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    name: info.file_name ?? null,
    bytes: info.file_size ?? null,
    state: record.state,
  };
}
