// AssetPreviewsController and ThumbnailsController (app/controllers/asset_previews_controller.rb, thumbnails_controller.rb): the product
// editor's cover and thumbnail uploads, on `/links/:link_id/...`.
//
// Ported: the 404s of `fetch_product_and_enforce_access`, the policy, the parameter refusals of #create and the answer for a
// preview or thumbnail the product does not have.
// Also ported: deleting a thumbnail that has an `unsplash_url`.
// Handed to Rails before any write: attaching an upload (Active Storage, an HTTP fetch of the url, image analysis), deleting a
// preview (its answer lists the product's previews with storage urls) and deleting a thumbnail backed by an uploaded file.
import { Prisma, type Thumbnail } from "@prisma/client";

import { castRow, column, selectRows, table } from "../models/sql.ts";
import { softDeletion, Thumbnails } from "../models/thumbnail.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { find } from "./products-mutations.ts";
import { authorizeJson, json } from "./seller-json.ts";

const BAD_REQUEST = 400;
const PREVIEW_FAILED = "Could not process your preview, please try again.";
const THUMBNAIL_PARAMETER = "Invalid thumbnail parameter. Expected signed_blob_id.";

// `unsplash_url.blank?`
const present = (value: string | null): value is string => value !== null && /[^\s]/u.test(value);

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// AssetPreviewPolicy and ThumbnailPolicy: the seller's admin and marketing roles.
const writer = linkPolicy.create;

// POST /links/:link_id/asset_previews
async function createPreview(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context) => authorize(writer, context), { requireAccountEmail: false });
  if (found.halt) return found.halt;
  // A JSON body without the key is wrapped under it by ParamsWrapper, which makes it a Parameters object that `require` then rejects.
  if (input.params.asset_preview === undefined)
    throw new HandBackToRails("a missing asset_preview, which JSON wrapping fills in");
  if (!isHash(input.params.asset_preview)) return json({ success: false, error: PREVIEW_FAILED });
  throw new HandBackToRails("attaching a preview, which fetches the file and analyzes it");
}

// DELETE /links/:link_id/asset_previews/:id
async function destroyPreview(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", () => undefined, { requireAccountEmail: false });
  if (found.halt) return found.halt;
  const guid = input.routeParams.id;
  const [preview] = guid
    ? await selectRows(
        Prisma.sql`SELECT ${column("asset_previews", "id")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${found.product.get("id")} AND ${column("asset_previews", "guid")} = ${guid} LIMIT 1`,
      )
    : [];
  // A stale editor deleting a preview the product does not have skips authorization.
  if (preview === undefined) return json({ success: false });
  const denied = await authorizeJson(input, (context) => authorize(writer, context));
  if (denied !== null) return denied;
  throw new HandBackToRails("deleting a preview, whose answer lists the product's previews");
}

// POST /links/:link_id/thumbnails
async function createThumbnail(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context) => authorize(writer, context));
  if (found.halt) return found.halt;
  if (input.params.thumbnail === undefined)
    throw new HandBackToRails("a missing thumbnail, which JSON wrapping fills in");
  if (!isHash(input.params.thumbnail)) return json({ success: false, error: THUMBNAIL_PARAMETER }, BAD_REQUEST);
  throw new HandBackToRails("attaching a thumbnail, which reads the blob and analyzes the image");
}

// DELETE /links/:link_id/thumbnails/:id
async function destroyThumbnail(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context) => authorize(writer, context));
  if (found.halt) return found.halt;
  const guid = input.routeParams.id;
  // `@product.thumbnail`: a has_one, so the first row, which the guid then has to match.
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`thumbnails`.*")} FROM ${table("thumbnails")} WHERE ${column("thumbnails", "product_id")} = ${found.product.get("id")} LIMIT 1`,
  );
  const thumbnail = row === undefined ? null : castRow<Thumbnail>("Thumbnail", row);
  if (thumbnail === null || thumbnail.guid !== guid) return json({ success: false });
  if (!present(thumbnail.unsplash_url))
    throw new HandBackToRails("a thumbnail backed by a file, whose answer carries its storage url");
  await softDeletion.markDeletedBang(Thumbnails.load(thumbnail));
  return json({ success: true, thumbnail: { url: thumbnail.unsplash_url, guid: thumbnail.guid } });
}

registerMutations(
  { method: "POST", pattern: "/links/:link_id/asset_previews", json: true, run: createPreview },
  { method: "DELETE", pattern: "/links/:link_id/asset_previews/:id", json: true, run: destroyPreview },
  { method: "POST", pattern: "/links/:link_id/thumbnails", json: true, run: createThumbnail },
  { method: "DELETE", pattern: "/links/:link_id/thumbnails/:id", json: true, run: destroyThumbnail },
);
