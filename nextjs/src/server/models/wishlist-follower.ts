// Port of app/models/wishlist_follower.rb and the part of wishlist_product.rb the wishlist controllers write through.
import { Prisma, type WishlistFollower, type WishlistProduct } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { belongsToRequired } from "./concerns/rails-validations.ts";
import { Wishlists } from "./wishlist.ts";
import { defineModel, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { column, table } from "./sql.ts";

const WISHLIST_PRODUCT_LIMIT = 100;

// `wishlist.increment!(:follower_count)`: update_counters, which does not touch updated_at.
async function adjustFollowerCount(wishlistId: unknown, delta: 1 | -1, ctx: CallbackContext): Promise<void> {
  await ctx.tx.$executeRaw(
    Prisma.sql`UPDATE ${table("wishlists")} SET ${column("wishlists", "follower_count")} = COALESCE(${column("wishlists", "follower_count")}, 0) ${Prisma.raw(delta === 1 ? "+" : "-")} 1 WHERE ${column("wishlists", "id")} = ${wishlistId}`,
  );
}

export const WishlistFollowers = defineModel<WishlistFollower>({
  rubyClass: "WishlistFollower",
  prismaModel: "WishlistFollower",
  delegate: (tx) => tx.wishlistFollower as never,
  validations: [
    belongsToRequired<WishlistFollower>({ name: "wishlist", foreignKey: "wishlist_id", targetTable: "wishlists", targetModel: "Wishlist" }),
    belongsToRequired<WishlistFollower>({ name: "follower_user", foreignKey: "follower_user_id", targetTable: "users", targetModel: "User" }),
    {
      name: "validates_uniqueness_of follower_user",
      async run(record, { tx }) {
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT 1 AS one FROM ${table("wishlist_followers")} WHERE ${column("wishlist_followers", "follower_user_id")} = ${record.get("follower_user_id")} AND ${column("wishlist_followers", "wishlist_id")} = ${record.get("wishlist_id")} AND ${record.get("deleted_at") == null ? Prisma.sql`${column("wishlist_followers", "deleted_at")} IS NULL` : Prisma.sql`${column("wishlist_followers", "deleted_at")} = ${record.get("deleted_at")}`}${record.persisted ? Prisma.sql` AND ${column("wishlist_followers", "id")} != ${record.get("id")}` : Prisma.empty} LIMIT 1`,
        );
        if (rows.length > 0) record.errors.add("follower_user", "taken", { message: "is already following this wishlist." });
      },
    },
    {
      name: "cannot_follow_own_wishlist",
      async run(record, { tx }) {
        const followerId = record.get("follower_user_id");
        if (followerId == null) return;
        const rows = await tx.$queryRaw<{ user_id: bigint | null }[]>(Prisma.sql`SELECT ${column("wishlists", "user_id")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${record.get("wishlist_id")} LIMIT 1`);
        if (rows[0]?.user_id === followerId) record.errors.add("base", "You cannot follow your own wishlist.");
      },
    },
  ],
  afterCreate: [{ name: "increment_follower_count", run: (record, ctx) => adjustFollowerCount(record.get("wishlist_id"), 1, ctx) }],
  afterUpdate: [
    {
      name: "update_follower_count",
      if: (record) => record.savedChangeTo("deleted_at"),
      run: (record, ctx) => adjustFollowerCount(record.get("wishlist_id"), record.get("deleted_at") == null ? 1 : -1, ctx),
    },
  ],
});

export const WishlistFollowerDeletable = deletable(WishlistFollowers);

// `wishlist.update_recommendable` after a product is added or removed: assign through the Wishlist's own before_save and save.
async function updateWishlistRecommendable(record: ModelRecord<WishlistProduct>, ctx: CallbackContext): Promise<void> {
  const [row] = await ctx.tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${Prisma.raw("`wishlists`.*")} FROM ${table("wishlists")} WHERE ${column("wishlists", "id")} = ${record.get("wishlist_id")} LIMIT 1`);
  if (!row) return;
  const wishlist = Wishlists.load(row as never);
  await Wishlists.save(wishlist, { now: ctx.now });
}

export const WishlistProducts = defineModel<WishlistProduct>({
  rubyClass: "WishlistProduct",
  prismaModel: "WishlistProduct",
  delegate: (tx) => tx.wishlistProduct as never,
  validations: [
    belongsToRequired<WishlistProduct>({ name: "wishlist", foreignKey: "wishlist_id", targetTable: "wishlists", targetModel: "Wishlist" }),
    belongsToRequired<WishlistProduct>({ name: "product", foreignKey: "product_id", targetTable: "links", targetModel: "Link" }),
    {
      name: "wishlist_product_limit",
      on: "create",
      async run(record, { tx }) {
        const [row] = await tx.$queryRaw<{ count: bigint }[]>(
          Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`count`")} FROM ${table("wishlist_products")} WHERE ${column("wishlist_products", "wishlist_id")} = ${record.get("wishlist_id")} AND ${column("wishlist_products", "deleted_at")} IS NULL`,
        );
        if (Number(row?.count ?? 0) >= WISHLIST_PRODUCT_LIMIT) record.errors.add("base", `A wishlist can have at most ${WISHLIST_PRODUCT_LIMIT} products`);
      },
    },
  ],
  afterCreate: [{ name: "update_wishlist_recommendable", run: updateWishlistRecommendable }],
  afterUpdate: [{ name: "update_wishlist_recommendable", if: (record) => record.savedChangeTo("deleted_at"), run: updateWishlistRecommendable }],
});

export const WishlistProductDeletable = deletable(WishlistProducts);
