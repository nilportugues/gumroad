// Port of app/models/wishlist.rb: validations, the recommendable before_save and the follower
// count scope. Not ported: ExternalId, Wishlist::StructuredData, seo_indexable(?), url slugs,
// followed_by?, wishlist_products_for_email.
import { Prisma, type Wishlist } from "@prisma/client";

import { isAdult } from "./concerns/adult-keyword-detector.ts";
import { deletable } from "./concerns/deletable.ts";
import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel, type CallbackContext } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesLengthOf, validatesPresenceOf } from "./runtime/validators.ts";
import { column, columnIn, table } from "./sql.ts";

export const WISHLISTS = "wishlists";
export const WISHLIST_FOLLOWERS = "wishlist_followers";
const WISHLIST_PRODUCTS = "wishlist_products";

export const DEFAULT_NAME_MATCHER = /^Wishlist \d+$/u;
export const MINIMUM_SEO_INDEXABLE_PRODUCTS = 3;
const DESCRIPTION_MAXIMUM = 3_000;

export const WISHLIST_FLAGS = { discover_opted_out: 1 } as const;
export const isDiscoverOptedOut = (wishlist: ModelRecord<Wishlist>) => (Number(wishlist.get("flags")) & WISHLIST_FLAGS.discover_opted_out) !== 0;

// `alive_wishlist_products.any?`
async function hasAliveWishlistProducts(wishlist: ModelRecord<Wishlist>, ctx: CallbackContext): Promise<boolean> {
  const rows = await ctx.tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT 1 AS one FROM ${table(WISHLIST_PRODUCTS)} WHERE ${column(WISHLIST_PRODUCTS, "wishlist_id")} = ${wishlist.get("id")} AND ${column(WISHLIST_PRODUCTS, "deleted_at")} IS NULL LIMIT 1`,
  );
  return rows.length > 0;
}

// update_recommendable(save: false); the && chain short-circuits before the products query.
export async function assignRecommendable(wishlist: ModelRecord<Wishlist>, ctx: CallbackContext): Promise<void> {
  const recommendable =
    !isDiscoverOptedOut(wishlist) &&
    !DEFAULT_NAME_MATCHER.test(wishlist.get("name")) &&
    !isAdult(wishlist.get("name")) &&
    !isAdult(wishlist.get("description")) &&
    (await hasAliveWishlistProducts(wishlist, ctx));
  wishlist.set("recommendable", recommendable);
}

export const Wishlists = defineModel<Wishlist>({
  rubyClass: "Wishlist",
  prismaModel: "Wishlist",
  delegate: (tx) => tx.wishlist as never,
  validations: [
    belongsToRequired<Wishlist>({ name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" }),
    validatesPresenceOf<Wishlist>(["name"]),
    validatesLengthOf<Wishlist>(["description"], { maximum: DESCRIPTION_MAXIMUM }),
  ],
  beforeSave: [{ name: "update_recommendable(save: false)", run: assignRecommendable }],
});

export const WishlistDeletable = deletable(Wishlists);

// `WishlistFollower.alive.where(wishlist_id: ids).where("created_at > ?", since).group(:wishlist_id).count`
export function recentFollowerCountsSql(wishlistIds: readonly unknown[], since: Date): Prisma.Sql {
  const F = WISHLIST_FOLLOWERS;
  return Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`count_all`")}, ${column(F, "wishlist_id")} AS ${Prisma.raw("`wishlist_followers_wishlist_id`")} FROM ${table(F)} WHERE ${column(F, "deleted_at")} IS NULL AND ${columnIn(F, "wishlist_id", wishlistIds)} AND (created_at > ${since}) GROUP BY ${column(F, "wishlist_id")}`;
}
