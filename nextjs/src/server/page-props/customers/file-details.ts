// CustomerPresenter#file_details for the files a buyer attached to a custom field answer (`purchase_custom_field.files`).
import path from "node:path";

import { Prisma } from "@prisma/client";

import { blobSignedId } from "../../infra/active-storage.ts";
import { column, selectRows, table } from "../../models/sql.ts";

export type FileDetails = { id: string; name: string; size: number; extension: string; key: string };

type AttachedBlobRow = {
  record_id: bigint;
  blob_id: bigint;
  key: string;
  filename: string;
  byte_size: bigint | number;
};

// ActiveStorage::Filename#to_s (#sanitized)
const sanitizedFilename = (filename: string) => filename.trim().replace(/[‮%$|:;/\t\r\n\\]/gu, "-");

export function fileDetails(blob: Pick<AttachedBlobRow, "blob_id" | "key" | "filename" | "byte_size">): FileDetails {
  const filename = sanitizedFilename(blob.filename);
  const extension = path.posix.extname(filename);
  return {
    id: blobSignedId(blob.blob_id),
    name: path.posix.basename(filename, extension),
    size: Number(blob.byte_size),
    extension: extension.replaceAll(".", "").toUpperCase(),
    key: blob.key,
  };
}

// `has_many_attached :files` of the given PurchaseCustomFields, in attachment order, by record id.
export async function customFieldFileDetails(fieldIds: bigint[]): Promise<Map<string, FileDetails[]>> {
  const byField = new Map<string, FileDetails[]>();
  if (fieldIds.length === 0) return byField;
  const attachments = (name: string) => column("active_storage_attachments", name);
  const blobs = (name: string) => column("active_storage_blobs", name);
  const rows = await selectRows<AttachedBlobRow>(
    Prisma.sql`SELECT ${attachments("record_id")}, ${attachments("blob_id")}, ${blobs("key")}, ${blobs("filename")}, ${blobs("byte_size")} FROM ${table("active_storage_attachments")} INNER JOIN ${table("active_storage_blobs")} ON ${blobs("id")} = ${attachments("blob_id")} WHERE ${attachments("record_type")} = 'PurchaseCustomField' AND ${attachments("name")} = 'files' AND ${attachments("record_id")} IN (${Prisma.join(fieldIds)}) ORDER BY ${attachments("id")} ASC`,
  );
  for (const row of rows) {
    const key = String(row.record_id);
    byField.set(key, [...(byField.get(key) ?? []), fileDetails(row)]);
  }
  return byField;
}
