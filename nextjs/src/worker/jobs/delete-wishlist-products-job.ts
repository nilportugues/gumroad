// Port of app/sidekiq/delete_wishlist_products_job.rb up to the first WishlistProduct#mark_deleted!: a product whose deletion was
// undone, and a deleted one nobody has wishlisted, finish here. A wishlist product to delete is handed back to Rails before it
// writes (the save re-runs Wishlist#update_recommendable). Golden: __fixtures__/delete-wishlist-products-job.golden.json
// (scripts/golden/delete-wishlist-products-job.rb).
import { Prisma, type Link } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1_000;

export const deleteWishlistProductsJobWith = modelJob({ min: 1 }, async ([productId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findByIdBang<Link>("Link", id);
  if (product.deleted_at === null) return;

  const alive = Prisma.sql`${column("wishlist_products", "product_id")} = ${id} AND ${column("wishlist_products", "deleted_at")} IS NULL`;
  await beforeSideEffects(() =>
    findInBatches("wishlist_products", alive, FIND_EACH_BATCH_SIZE, () =>
      Promise.reject(
        new NotPortedError("WishlistProduct#mark_deleted!", "wishlist_product.rb (Wishlist#update_recommendable)"),
      ),
    ),
  );
});
export const deleteWishlistProductsJob = deleteWishlistProductsJobWith();
