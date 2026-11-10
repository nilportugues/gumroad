// Api::V2::MediaController#index (app/controllers/api/v2/media_controller.rb). #create and #destroy download remote files, moderate
// them and purge blobs: they stay in Rails.
import { Prisma } from "@prisma/client";

import { isConfiguredService, publicStorageUrl } from "../../infra/active-storage.ts";
import { cdnUrlFor } from "../../infra/cdn-url.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, registerApiV2, renderResponse } from "./base.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const iso8601 = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;

// PublicFilePresenter#props merged with the controller's file_group and created_at. A file without an attached blob has no url
// or size; a blob on a storage service other than the configured public one has a URL the port cannot build.
export async function index({ owner }: Pick<ApiV2Input, "owner">) {
  const files = await selectRows<Row>(
    Prisma.sql`SELECT ${table("public_files")}.* FROM ${table("public_files")} WHERE ${column("public_files", "deleted_at")} IS NULL AND ${column("public_files", "seller_id")} = ${owner.id} AND ${column("public_files", "resource_type")} = 'User' AND ${column("public_files", "resource_id")} = ${owner.id} ORDER BY ${column("public_files", "id")} DESC`,
  );
  const blobs = new Map<string, Row>();
  if (files.length > 0) {
    const attachments = (name: string) => column("active_storage_attachments", name);
    const rows = await selectRows<Row>(
      Prisma.sql`SELECT ${attachments("record_id")}, ${column("active_storage_blobs", "key")}, ${column("active_storage_blobs", "byte_size")}, ${column("active_storage_blobs", "service_name")} FROM ${table("active_storage_attachments")} INNER JOIN ${table("active_storage_blobs")} ON ${column("active_storage_blobs", "id")} = ${attachments("blob_id")} WHERE ${attachments("record_type")} = 'PublicFile' AND ${attachments("name")} = 'file' AND ${attachments("record_id")} IN (${Prisma.join(files.map((file) => file.id))}) ORDER BY ${attachments("id")} ASC`,
    );
    // has_one_attached keeps the first attachment it loads.
    for (const row of rows) if (!blobs.has(String(row.record_id))) blobs.set(String(row.record_id), row);
  }
  const media = files.map((file) => {
    const blob = blobs.get(String(file.id));
    if (blob && !isConfiguredService(blob.service_name))
      throw new HandBackToRails("a media file stored on a service the port does not configure");
    return {
      id: file.public_id,
      name: file.display_name,
      extension: file.file_type?.toUpperCase() ?? null,
      file_size: blob ? Number(blob.byte_size) : null,
      url: blob ? cdnUrlFor(publicStorageUrl(blob.key)) : null,
      status: { type: "saved" },
      file_group: file.file_group,
      created_at: iso8601(file.created_at),
    };
  });
  return renderResponse(true, { media });
}

registerApiV2({
  method: "GET",
  pattern: "/v2/media",
  scopes: ["view_profile"],
  requireScope: ["view_profile"],
  run: index,
});
