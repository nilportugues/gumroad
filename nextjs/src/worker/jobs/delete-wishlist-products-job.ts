// Port of app/sidekiq/delete_wishlist_products_job.rb. A wishlist product that WishlistProduct's quantity, rent and variant
// validations could reject (a variant, a quantity above one, rent, or a rentable product) is handed back to Rails when
// reached; the job is idempotent (it only reads alive rows), so Rails re-running it after earlier rows were deleted here is safe. Golden: __fixtures__/delete-wishlist-products-job.golden.json (scripts/golden/delete-wishlist-products-job.rb).
import { Prisma, type Link, type WishlistProduct } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, findInBatches } from "../../server/models/sql.ts";
import { WishlistProductDeletable, WishlistProducts } from "../../server/models/wishlist-follower.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;
const BUY_ONLY = 0;

function unvalidatedReason(product: Link, row: WishlistProduct): string | null {
  if (row.variant_id !== null) return "a wishlist product with a variant";
  if (row.quantity !== 1 || row.rent) return "a wishlist product with a quantity above one or rent";
  if ((product.purchase_type ?? BUY_ONLY) !== BUY_ONLY) return "a wishlist product of a rentable product";
  return null;
}

export const deleteWishlistProductsJobWith = modelJob({ min: 1 }, async ([productId], deps) => {
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findByIdBang<Link>("Link", id);
  if (product.deleted_at === null) return;

  const alive = Prisma.sql`${column("wishlist_products", "product_id")} = ${id} AND ${column("wishlist_products", "deleted_at")} IS NULL`;
  await findInBatches<WishlistProduct>("wishlist_products", alive, FIND_EACH_BATCH_SIZE, async (rows) => {
    for (const row of rows) {
      const wishlistProduct = castRow<WishlistProduct>("WishlistProduct", row);
      const reason = unvalidatedReason(product, wishlistProduct);
      if (reason !== null) throw new HandBackToRuby(reason);
      await WishlistProductDeletable.markDeletedBang(WishlistProducts.load(wishlistProduct), { now: deps.now });
    }
  });
});
export const deleteWishlistProductsJob = deleteWishlistProductsJobWith();
