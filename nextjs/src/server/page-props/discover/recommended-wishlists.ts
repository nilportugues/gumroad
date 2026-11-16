// DiscoverController#recommended_wishlists_data: RecommendedWishlistsService.fetch(limit: 4, current_seller:,
// curated_product_ids:, taxonomy_id:) and WishlistPresenter.cards_props.
import { Prisma } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { column, columnIn, columnNotIn, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { wishlistCardProps } from "../storefront/featured-and-wishlist-sections.ts";

export const RECOMMENDED_WISHLISTS_LIMIT = 4;
const MATCHING_CANDIDATES_LIMIT = 10_000;
const DISCOVER_LAYOUT = "discover";
const GUMROAD_DISCOVER_WISHLIST_RECOMMENDATION = "discover_wishlist";

// `scope.where.not(user_id: current_seller.id)`: a signed-in seller never sees their own wishlists.
const recommendable = (currentSellerId: bigint | null, exceptIds: bigint[] = []) =>
  Prisma.sql`SELECT ${table("wishlists")}.* FROM ${table("wishlists")} WHERE ${column("wishlists", "recommendable")} = TRUE${currentSellerId === null ? Prisma.empty : Prisma.sql` AND ${column("wishlists", "user_id")} != ${currentSellerId}`}${exceptIds.length === 0 ? Prisma.empty : Prisma.sql` AND ${columnNotIn("wishlists", "id", exceptIds)}`} ORDER BY ${column("wishlists", "recent_follower_count")} DESC`;

// The ids RecommendedWishlistsService.fetch returns, in order.
export async function recommendedWishlistIds(
  taxonomyId: bigint | null,
  currentSellerId: bigint | null = null,
  curatedProductIds: bigint[] = [],
): Promise<bigint[]> {
  if (taxonomyId === null && curatedProductIds.length === 0) {
    const rows = await selectRows<{ id: bigint }>(
      Prisma.sql`${recommendable(currentSellerId)} LIMIT ${Prisma.raw(String(RECOMMENDED_WISHLISTS_LIMIT))}`,
    );
    return rows.map((row) => row.id);
  }
  // Both `joins` name wishlist_products, so one row of it has to match the curated products and the taxonomy together.
  const taxonomyJoin =
    taxonomyId === null
      ? Prisma.empty
      : Prisma.sql` INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("wishlist_products", "product_id")}`;
  const conditions = [
    ...(curatedProductIds.length === 0 ? [] : [columnIn("wishlist_products", "product_id", curatedProductIds)]),
    ...(taxonomyId === null ? [] : [Prisma.sql`${column("links", "taxonomy_id")} = ${taxonomyId}`]),
  ];
  const matching = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT DISTINCT ${table("wishlists")}.* FROM (${recommendable(currentSellerId)} LIMIT ${Prisma.raw(String(MATCHING_CANDIDATES_LIMIT))}) ${table("wishlists")} INNER JOIN ${table("wishlist_products")} ON ${column("wishlist_products", "wishlist_id")} = ${column("wishlists", "id")}${taxonomyJoin} WHERE ${Prisma.join(conditions, " AND ")} LIMIT ${Prisma.raw(String(RECOMMENDED_WISHLISTS_LIMIT))}`,
  );
  const ids = matching.map((row) => row.id);
  // Without a taxonomy, a partial match is topped up with the best remaining wishlists.
  const missing = RECOMMENDED_WISHLISTS_LIMIT - ids.length;
  if (taxonomyId === null && missing > 0 && missing < RECOMMENDED_WISHLISTS_LIMIT) {
    const rest = await selectRows<{ id: bigint }>(
      Prisma.sql`${recommendable(currentSellerId, ids)} LIMIT ${Prisma.raw(String(missing))}`,
    );
    ids.push(...rest.map((row) => row.id));
  }
  // The final `ORDER BY FIELD(id, )` is a syntax error in MySQL, so Rails 500s here.
  if (ids.length === 0) throw new NotPortedError("RecommendedWishlistsService.fetch with no matching wishlists");
  return ids;
}

export async function recommendedWishlistsProps(
  taxonomyId: bigint | null,
  currentSellerId: bigint | null = null,
  curatedProductIds: bigint[] = [],
) {
  const ids = await recommendedWishlistIds(taxonomyId, currentSellerId, curatedProductIds);
  const wishlists = await db.wishlist.findMany({ where: { id: { in: ids } } });
  const byId = new Map(wishlists.map((wishlist) => [wishlist.id, wishlist]));
  // cards_props: the wishlists the current seller already follows.
  const following = new Set(
    currentSellerId === null
      ? []
      : (
          await db.wishlistFollower.findMany({
            where: { follower_user_id: currentSellerId, wishlist_id: { in: ids }, deleted_at: null },
            select: { wishlist_id: true },
          })
        ).map((row) => row.wishlist_id),
  );
  const cards = [];
  for (const id of ids) {
    const wishlist = byId.get(id);
    if (wishlist)
      cards.push(
        await wishlistCardProps(wishlist, {
          layout: DISCOVER_LAYOUT,
          recommendedBy: GUMROAD_DISCOVER_WISHLIST_RECOMMENDATION,
          following: following.has(id),
          currentSellerId,
        }),
      );
  }
  return cards;
}
