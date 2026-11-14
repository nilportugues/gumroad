// Api::V2::MediaController#index (app/controllers/api/v2/media_controller.rb), the lookup of #destroy and the refusals of #create ahead of its
// download. #create is throttled by Rack::Attack, which Node counts ahead of the action (rack-attack.ts) and takes back when it hands the request
// over; the SSRF-guarded download, the content moderation and the public file are Rails'. Deleting a file purges its blob from storage, so it
// goes to Rails too.
import { Prisma } from "@prisma/client";

import { isConfiguredService, publicStorageUrl } from "../../infra/active-storage.ts";
import { cdnUrlFor } from "../../infra/cdn-url.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { RISK_STATES } from "../../models/user.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, errorWithObject, json, present, registerApiV2, renderResponse } from "./base.ts";

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

// `media_files.find_by(public_id: params[:id])`
export async function destroy({ owner, routeParams }: Pick<ApiV2Input, "owner" | "routeParams">) {
  const [file] = await selectRows<Row>(
    Prisma.sql`SELECT ${column("public_files", "id")} FROM ${table("public_files")} WHERE ${column("public_files", "deleted_at")} IS NULL AND ${column("public_files", "seller_id")} = ${owner.id} AND ${column("public_files", "resource_type")} = 'User' AND ${column("public_files", "resource_id")} = ${owner.id} AND ${column("public_files", "public_id")} = ${routeParams.id!} LIMIT 1`,
  );
  if (file === undefined) return errorWithObject("media", null);
  throw new HandBackToRails("deleting a hosted file, which purges its blob from storage");
}

registerApiV2({
  method: "DELETE",
  pattern: "/v2/media/:id",
  scopes: ["edit_profile"],
  requireScope: ["edit_profile"],
  run: destroy,
});

// `before_action { render_account_inactive unless current_resource_owner&.account_active? }`: alive and not suspended.
const accountActive = (owner: ApiV2Input["owner"]) =>
  owner.deleted_at === null && !(RISK_STATES.SUSPENDED as readonly string[]).includes(owner.user_risk_state ?? "");

// CreatePublicMediaService#process starts with `url.blank? && signed_blob_id.blank?` (both read through `presence`).
export function create({ params }: Pick<ApiV2Input, "params">) {
  for (const key of ["url", "signed_blob_id"] as const)
    if (present(params[key]) && typeof params[key] !== "string")
      throw new HandBackToRails("a media source that is not text");
  if (!present(params.url) && !present(params.signed_blob_id))
    return renderResponse(false, { message: "Please provide a url or signed_blob_id." });
  throw new HandBackToRails("hosting a file: the download, the moderation and the public file");
}

registerApiV2({
  method: "POST",
  pattern: "/v2/media",
  scopes: ["edit_profile"],
  requireScope: ["edit_profile"],
  before: ({ owner }) =>
    Promise.resolve(
      accountActive(owner) ? undefined : json({ success: false, message: "Your account is not active." }, 403),
    ),
  run: create,
});
