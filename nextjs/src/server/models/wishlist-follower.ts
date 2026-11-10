// Port of app/models/wishlist_follower.rb and the part of wishlist_product.rb the wishlist controllers write through.
import { Prisma, type Wishlist, type WishlistFollower, type WishlistProduct } from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { belongsToRequired } from "./concerns/rails-validations.ts";
import { LinkFlags } from "./link.ts";
import { Wishlists } from "./wishlist.ts";
import { defineModel, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, table } from "./sql.ts";

const WISHLIST_PRODUCT_LIMIT = 100;
// BasePrice::Recurrence::ALLOWED_RECURRENCES
const ALLOWED_RECURRENCES = ["monthly", "quarterly", "biannually", "yearly", "every_two_years"];

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
  // castRow turns the tinyint `recommendable` into a boolean, or an unchanged value would count as a change and touch updated_at.
  const wishlist = Wishlists.load(castRow<Wishlist>("Wishlist", row));
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
      name: "recurrence matches the product",
      async run(record, { tx }) {
        const [product] = await tx.$queryRaw<{ flags: bigint }[]>(Prisma.sql`SELECT ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${record.get("product_id")} LIMIT 1`);
        const recurrence = record.get("recurrence");
        if (product && LinkFlags.isSet(product.flags as never, "is_recurring_billing")) {
          if (!ALLOWED_RECURRENCES.includes(recurrence ?? "")) record.errors.add("recurrence", "inclusion");
        } else if (recurrence != null && recurrence !== "") record.errors.add("recurrence", "present");
      },
    },
    {
      name: "versioned_product_has_variant",
      unless: (record) => record.attributeChanged("deleted_at", { from: null }),
      async run(record, { tx }) {
        if (record.get("variant_id") != null) return;
        const [product] = await tx.$queryRaw<{ flags: bigint }[]>(Prisma.sql`SELECT ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} = ${record.get("product_id")} LIMIT 1`);
        if (!product) return;
        // `skus.alive.not_is_default_sku.count > 1 || alive_variants.present?`
        const [skus] = LinkFlags.isSet(product.flags as never, "skus_enabled")
          ? await tx.$queryRaw<{ count: bigint }[]>(
              Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`count`")} FROM ${table("base_variants")} WHERE ${column("base_variants", "link_id")} = ${record.get("product_id")} AND ${column("base_variants", "type")} = 'Sku' AND ${column("base_variants", "deleted_at")} IS NULL AND (${column("base_variants", "flags")} & 1) = 0`,
            )
          : [];
        const [variant] =
          Number(skus?.count ?? 0) > 1
            ? [{}]
            : await tx.$queryRaw<unknown[]>(
                Prisma.sql`SELECT 1 AS one FROM ${table("base_variants")} JOIN ${table("variant_categories")} ON ${column("variant_categories", "id")} = ${column("base_variants", "variant_category_id")} WHERE ${column("variant_categories", "link_id")} = ${record.get("product_id")} AND ${column("variant_categories", "deleted_at")} IS NULL AND ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "deleted_at")} IS NULL LIMIT 1`,
              );
        if (variant) record.errors.add("base", "Wishlist product must have variant specified for versioned product");
      },
    },
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
