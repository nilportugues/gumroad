// AssetPreviewsController and ThumbnailsController (app/controllers/asset_previews_controller.rb, thumbnails_controller.rb): the product
// editor's cover and thumbnail uploads, on `/links/:link_id/...`.
//
// Ported: the 404s of `fetch_product_and_enforce_access`, the policy, the parameter refusals of #create (a blob id whose signature
// does not verify, and a JSON body that ParamsWrapper leaves with nothing to wrap) and the answer for a preview or thumbnail the
// product does not have.
// Also ported: deleting a thumbnail that has an `unsplash_url`, and deleting a preview that has no upload.
// Handed to Rails before any write: attaching an upload (Active Storage, an HTTP fetch of the url, image analysis), deleting a
// preview with an upload (its answer lists storage urls) and deleting a thumbnail backed by an uploaded file.
import { Prisma, type AssetPreview, type Thumbnail } from "@prisma/client";

import { railsMessageVerifierVerified } from "../auth/message-verifier.ts";
import { AssetPreviews, softDeletion as previewDeletion } from "../models/asset-preview.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { softDeletion, Thumbnails } from "../models/thumbnail.ts";
import { authorize } from "../policies/authorize.ts";
import { linkPolicy } from "../policies/link.ts";
import { uploadedFiles } from "../presenters/asset-preview-upload.ts";
import { coverProps } from "../presenters/product-props-extras.ts";

import { HandBackToRails, ParameterMissing, type ActionResult } from "./application-controller.ts";
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

const INVALID_BLOB = "Invalid signed_blob_id.";
// `ActiveStorage::Blob.signed_id`'s verifier and purpose.
const BLOB_VERIFIER = "ActiveStorage";
const BLOB_PURPOSE = "blob_id";

// The attributes ParamsWrapper copies under the controller's key (the model's columns): a JSON body with none of them is wrapped as
// an empty object, which `params.require` then rejects.
const PREVIEW_ATTRIBUTES = [
  "id",
  "link_id",
  "guid",
  "oembed",
  "created_at",
  "updated_at",
  "deleted_at",
  "position",
  "unsplash_url",
];
const THUMBNAIL_ATTRIBUTES = ["id", "product_id", "deleted_at", "guid", "created_at", "updated_at", "unsplash_url"];

const wrapsNothing = (input: MutationInput, attributes: string[]) =>
  /^application\/json\b/iu.test(input.request.headers.get("content-type") ?? "") &&
  attributes.every((name) => input.params[name] === undefined);

// `ActiveStorage::Blob.find_signed` answers nil for an id whose signature does not verify. One that verifies may still name a blob
// that is gone, which only Rails can tell.
const signedBlobIdIsForged = (value: unknown) =>
  typeof value === "string" && present(value) && railsMessageVerifierVerified(BLOB_VERIFIER, value, BLOB_PURPOSE) === null;

// AssetPreviewPolicy and ThumbnailPolicy: the seller's admin and marketing roles.
const writer = linkPolicy.create;

// POST /links/:link_id/asset_previews
async function createPreview(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context) => authorize(writer, context), { requireAccountEmail: false });
  if (found.halt) return found.halt;
  // A JSON body without the key is wrapped under it by ParamsWrapper, which makes it a Parameters object that `require` then rejects.
  if (input.params.asset_preview === undefined) {
    if (wrapsNothing(input, PREVIEW_ATTRIBUTES)) throw new ParameterMissing();
    throw new HandBackToRails("a missing asset_preview, which JSON wrapping fills in");
  }
  if (!isHash(input.params.asset_preview)) return json({ success: false, error: PREVIEW_FAILED });
  if (signedBlobIdIsForged(input.params.asset_preview.signed_blob_id))
    return json({ success: false, error: INVALID_BLOB }, BAD_REQUEST);
  throw new HandBackToRails("attaching a preview, which fetches the file and analyzes it");
}

// DELETE /links/:link_id/asset_previews/:id
async function destroyPreview(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", () => undefined, { requireAccountEmail: false });
  if (found.halt) return found.halt;
  const guid = input.routeParams.id;
  const [row] = guid
    ? await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`asset_previews`.*")} FROM ${table("asset_previews")} WHERE ${column("asset_previews", "link_id")} = ${found.product.get("id")} AND ${column("asset_previews", "guid")} = ${guid} LIMIT 1`,
      )
    : [];
  // A stale editor deleting a preview the product does not have skips authorization.
  if (row === undefined) return json({ success: false });
  const denied = await authorizeJson(input, (context) => authorize(writer, context));
  if (denied !== null) return denied;
  const preview = castRow<AssetPreview>("AssetPreview", row);
  // An upload's answer carries storage urls, and its save runs the file validators.
  if ((await uploadedFiles([preview.id])).has(preview.id))
    throw new HandBackToRails("deleting a preview with an upload, whose answer lists storage urls");
  // The list as it reads once the preview is gone, built before the write so a cover Node cannot render still hands back whole.
  const left = await coverProps({ id: BigInt(found.product.get("id")) }, preview.id);
  await previewDeletion.markDeletedBang(AssetPreviews.load(preview));
  return json({ success: true, asset_previews: left.covers, active_preview_id: left.main_cover_id });
}

// POST /links/:link_id/thumbnails
async function createThumbnail(input: MutationInput): Promise<ActionResult> {
  const found = await find(input, "access", (context) => authorize(writer, context));
  if (found.halt) return found.halt;
  if (input.params.thumbnail === undefined) {
    if (wrapsNothing(input, THUMBNAIL_ATTRIBUTES)) throw new ParameterMissing();
    throw new HandBackToRails("a missing thumbnail, which JSON wrapping fills in");
  }
  if (!isHash(input.params.thumbnail)) return json({ success: false, error: THUMBNAIL_PARAMETER }, BAD_REQUEST);
  if (signedBlobIdIsForged(input.params.thumbnail.signed_blob_id))
    return json({ success: false, error: INVALID_BLOB }, BAD_REQUEST);
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
