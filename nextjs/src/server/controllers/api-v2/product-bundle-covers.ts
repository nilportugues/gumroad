// Api::V2::BundleContentsController#update, Api::V2::CoversController and Api::V2::LinksController#enable: the before_actions and the
// refusals that precede any write. A request that reaches a write goes to Rails whole: bundle contents run Bundle::UpdateProductsService
// under a row lock, a cover is attached from a blob or fetched from a URL, and #enable publishes (price checks, transcoding, mail).
import type { Link } from "@prisma/client";

import { db } from "../../../lib/db.ts";

import { type ApiV2Input, EDIT_PRODUCTS_SCOPES, loadProduct, registerApiV2, renderResponse } from "./base.ts";
import { linkFlag } from "./records.ts";
import { blankParam, isHash, notPorted, rubyInteger } from "./ruby-params.ts";

const productOf = (input: ApiV2Input) => input.state.product as Link;

// BundleContentsController::MAX_INTEGER
const MAX_INTEGER = 2_147_483_647n;
// The permitted keys of one product entry.
const ENTRY_KEYS = ["product_id", "variant_id", "quantity", "position"];

// BundleContentsController#validate_products: the first message, or null.
function validateProducts(products: Record<string, unknown>[]): string | null {
  for (const entry of products) {
    for (const key of ENTRY_KEYS)
      if (isHash(entry[key]) || Array.isArray(entry[key])) notPorted("a product entry value that is not a scalar");
    // `p[:quantity] = 1 if p[:quantity].nil?`
    const quantity = rubyInteger(entry.quantity ?? 1);
    if (quantity === null || quantity < 1n || quantity > MAX_INTEGER)
      return "Quantity must be an integer greater than 0.";
    // `p[:position].present?`: false and a blank string are skipped, true is present.
    if (!blankParam(entry.position)) {
      const position = rubyInteger(entry.position);
      if (position === null || position > MAX_INTEGER) return "Position must be a valid integer.";
    }
  }
  return null;
}

function updateBundleContents(input: ApiV2Input) {
  if (!linkFlag(productOf(input), "is_bundle"))
    return renderResponse(false, { message: "This product is not a bundle." });
  const products = input.params.products;
  // `params.permit(products: [...]).fetch(:products, [])` reshapes anything but a list of hashes in ways the port does not follow.
  if (!Array.isArray(products) || !products.every(isHash))
    return notPorted("a products parameter that is not a list of hashes");
  const message = validateProducts(products);
  if (message !== null) return renderResponse(false, { message });
  return notPorted("replacing the contents of a bundle");
}

registerApiV2({
  method: "PUT",
  pattern: "/v2/products/:link_id/bundle_contents",
  scopes: EDIT_PRODUCTS_SCOPES,
  before: loadProduct("link_id"),
  run: updateBundleContents,
});

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::CoversController

const INVALID_BLOB = "The signed_blob_id is invalid or expired.";

function createCover({ params }: ApiV2Input) {
  const signedBlobId = params.signed_blob_id;
  if (!blankParam(signedBlobId)) {
    // A non-String attachable raises ArgumentError in Rails, which the controller turns into this message.
    if (typeof signedBlobId !== "string") return renderResponse(false, { message: INVALID_BLOB });
  } else if (blankParam(params.url)) {
    return renderResponse(false, { message: "Please provide a signed_blob_id or url." });
  }
  return notPorted("attaching a cover from a blob or a URL");
}

async function destroyCover(input: ApiV2Input) {
  // `@product.asset_previews.alive.find_by(guid: params[:id])`
  const cover = await db.assetPreview.findFirst({
    where: { link_id: productOf(input).id, deleted_at: null, guid: input.routeParams.id! },
    select: { id: true },
  });
  if (cover === null) return renderResponse(false, { message: "The cover was not found." });
  return notPorted("deleting a cover, which touches the product and renders its remaining covers");
}

registerApiV2(
  {
    method: "POST",
    pattern: "/v2/products/:link_id/covers",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    run: createCover,
  },
  {
    method: "DELETE",
    pattern: "/v2/products/:link_id/covers/:id",
    scopes: EDIT_PRODUCTS_SCOPES,
    before: loadProduct("link_id"),
    run: destroyCover,
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Api::V2::LinksController#enable

registerApiV2({
  method: "PUT",
  pattern: "/v2/products/:id/enable",
  scopes: EDIT_PRODUCTS_SCOPES,
  before: loadProduct("id"),
  run: () => notPorted("publishing a product"),
});
