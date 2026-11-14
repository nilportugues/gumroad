// Api::V2::ThumbnailsController (app/controllers/api/v2/thumbnails_controller.rb): the answers it gives before it touches storage or the
// database, and the soft-delete. Attaching a blob or fetching a URL goes through Active Storage and SsrfFilter; Rails takes those whole.
import { db } from "../../../lib/db.ts";
import { softDeletion, Thumbnails } from "../../models/thumbnail.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, loadProduct, present, registerApiV2, renderResponse } from "./base.ts";

async function create({ params }: ApiV2Input) {
  const signedBlobId = params.signed_blob_id;
  if (present(signedBlobId)) {
    // A non-String attachable raises ArgumentError, which the action's rescues do not cover.
    if (typeof signedBlobId !== "string")
      return renderResponse(false, { message: "The signed_blob_id is invalid or expired." });
    // A signed id is `payload--digest`: text without the separator never verifies, whatever the secret.
    if (!signedBlobId.includes("--"))
      return renderResponse(false, { message: "The signed_blob_id is invalid or expired." });
    throw new HandBackToRails("a thumbnail attached from a signed blob");
  }
  if (present(params.url)) throw new HandBackToRails("a thumbnail fetched from a URL");
  return renderResponse(false, { message: "Please provide a signed_blob_id or url." });
}

async function destroy({ state }: ApiV2Input) {
  // `@product.thumbnail`: the has_one is not limited to live rows, so a deleted thumbnail answers "not found" too.
  const thumbnail = await db.thumbnail.findFirst({
    where: { product_id: Number(state.product.id) },
    orderBy: { id: "asc" },
  });
  if (thumbnail === null || thumbnail.deleted_at !== null)
    return renderResponse(false, { message: "The thumbnail was not found." });
  // Alive, so Thumbnail#validate_file is skipped for the deleted row; the save touches the product (`belongs_to :product, touch: true`).
  await softDeletion.markDeletedBang(Thumbnails.load(thumbnail));
  return renderResponse(true, { thumbnail: null });
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products/:link_id/thumbnail",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    run: create,
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/thumbnail",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    run: destroy,
  },
);
