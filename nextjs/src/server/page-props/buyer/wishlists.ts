// WishlistPresenter.library_props and the reads behind WishlistsController#index and
// Wishlists::FollowingController#index. The public wishlist page (WishlistPresenter#public_props,
// ProductPresenter.card_for_web) is not ported.
import { Prisma, type User, type Wishlist } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { encrypt, encryptNumeric } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { parameterize } from "../meta-tags.ts";
import { avatarUrl, profileUrl, userNameOrUsername, userSubdomainWithProtocol } from "./users.ts";

const WISHLISTS = "wishlists";
const WISHLIST_PRODUCTS = "wishlist_products";
const WISHLIST_FOLLOWERS = "wishlist_followers";
const DISCOVER_OPTED_OUT_FLAG = 1n;

// Wishlist#url_slug
export const urlSlug = (wishlist: Wishlist) => `${parameterize(wishlist.name)}-${encryptNumeric(Number(wishlist.id))}`;

// `current_seller.wishlists.alive`
export function aliveWishlistsOf(userId: bigint): Promise<Wishlist[]> {
  return db.wishlist.findMany({ where: { user_id: userId, deleted_at: null }, orderBy: { id: "asc" } });
}

// `current_seller.alive_following_wishlists`: wishlists joined through the alive follows.
export async function aliveFollowingWishlistsOf(userId: bigint): Promise<Wishlist[]> {
  const ids = await selectRows<{ wishlist_id: bigint }>(
    Prisma.sql`SELECT ${column(WISHLIST_FOLLOWERS, "wishlist_id")} FROM ${table(WISHLIST_FOLLOWERS)} WHERE ${column(WISHLIST_FOLLOWERS, "follower_user_id")} = ${userId} AND ${column(WISHLIST_FOLLOWERS, "deleted_at")} IS NULL ORDER BY ${column(WISHLIST_FOLLOWERS, "id")} ASC`,
  );
  const wishlists = await db.wishlist.findMany({ where: { id: { in: ids.map((row) => row.wishlist_id) } } });
  const byId = new Map(wishlists.map((wishlist) => [wishlist.id, wishlist]));
  return ids.flatMap((row) => byId.get(row.wishlist_id) ?? []);
}

// `wishlists.joins(:alive_wishlist_products).group("wishlists.id").count`
async function aliveProductCounts(wishlists: Wishlist[]): Promise<Map<bigint, number>> {
  if (wishlists.length === 0) return new Map();
  const rows = await selectRows<{ wishlist_id: bigint; count: bigint }>(
    Prisma.sql`SELECT ${column(WISHLIST_PRODUCTS, "wishlist_id")}, COUNT(*) AS count FROM ${table(WISHLIST_PRODUCTS)} WHERE ${column(WISHLIST_PRODUCTS, "wishlist_id")} IN (${Prisma.join(wishlists.map((wishlist) => wishlist.id))}) AND ${column(WISHLIST_PRODUCTS, "deleted_at")} IS NULL GROUP BY ${column(WISHLIST_PRODUCTS, "wishlist_id")}`,
  );
  return new Map(rows.map((row) => [row.wishlist_id, Number(row.count)]));
}

async function creatorsOf(wishlists: Wishlist[]): Promise<Map<bigint, User>> {
  const users = await db.user.findMany({ where: { id: { in: wishlists.flatMap((wishlist) => (wishlist.user_id === null ? [] : [wishlist.user_id])) } } });
  return new Map(users.map((user) => [user.id, user]));
}

// WishlistPresenter.library_props
export async function wishlistsLibraryProps(wishlists: Wishlist[], { isWishlistCreator = true } = {}) {
  const [counts, creators] = await Promise.all([aliveProductCounts(wishlists), creatorsOf(wishlists)]);
  const props = [];
  for (const wishlist of wishlists) {
    const creator = creators.get(wishlist.user_id!);
    if (!creator) throw new TypeError("undefined method 'subdomain_with_protocol' for nil");
    props.push({
      id: encrypt(wishlist.id),
      name: wishlist.name,
      url: `${userSubdomainWithProtocol(creator)}/wishlists/${urlSlug(wishlist)}`,
      product_count: counts.get(wishlist.id) ?? 0,
      creator: isWishlistCreator ? null : { name: userNameOrUsername(creator), profile_url: profileUrl(creator), avatar_url: await avatarUrl(creator) },
      discover_opted_out: isWishlistCreator ? (BigInt(wishlist.flags) & DISCOVER_OPTED_OUT_FLAG) !== 0n : null,
    });
  }
  return props;
}
