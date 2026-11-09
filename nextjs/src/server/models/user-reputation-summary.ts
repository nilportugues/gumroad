// Port of User::ReputationSummary#seller_reputation_summary (app/modules/user/reputation_summary.rb), without
// exclude_product or snapshot_only: those belong to the product page, which reads a Redis snapshot and queues a job.
// The SQL is the aggregate Rails caches under a key that moves with every write that could change it, so reading
// it directly answers the same.
import { Prisma } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { column, selectRows, table } from "./sql.ts";

export const REPUTATION_SUMMARY_FEATURE = "seller_reputation_summary";
// User::ReputationSummary::MIN_REVIEWS and MIN_PRODUCTS
export const MIN_REVIEWS = 10;
export const MIN_PRODUCTS = 2;
// Link flag 17 (display_product_reviews); flag_shih_tzu numbers bits from 1.
const DISPLAY_PRODUCT_REVIEWS_BIT = 1 << 16;
const DECIMAL_PLACES_SCALE = 10;

export type ReputationSummary = { average: number; count: number; products_count: number };

// Numeric#to_i on a COUNT/SUM column (Integer, BigDecimal or nil).
function toI(value: unknown): number {
  if (value == null) return 0;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).trunc().toNumber();
  return Math.trunc(Number(value));
}

// Float#round(1): C's round(x * 10) / 10, then MRI's round_half_up correction.
export function rubyRoundToTenths(value: number): number {
  let rounded = Math.round(value * DECIMAL_PLACES_SCALE);
  if ((rounded + 0.5) / DECIMAL_PLACES_SCALE <= value) rounded += 1;
  return rounded / DECIMAL_PLACES_SCALE;
}

// build_summary: nil below the display gate.
export function buildReputationSummary([products, total, weighted]: readonly [number, number, number]): ReputationSummary | null {
  if (total < MIN_REVIEWS || products < MIN_PRODUCTS) return null;
  return { average: rubyRoundToTenths(weighted / total), count: total, products_count: products };
}

// reputation_aggregate: the seller's alive, non-draft products that show reviews and have some.
async function reputationAggregate(sellerId: bigint | number): Promise<[number, number, number]> {
  const [row] = await selectRows<unknown[]>(
    Prisma.sql`SELECT COUNT(*), SUM(reviews_count), SUM(ratings_of_five_count * 5 + ratings_of_four_count * 4 + ratings_of_three_count * 3 + ratings_of_two_count * 2 + ratings_of_one_count) FROM ${table("links")} FORCE INDEX (index_links_on_user_id) STRAIGHT_JOIN product_review_stats ON product_review_stats.link_id = links.id WHERE ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "draft")} = FALSE AND ${column("links", "user_id")} = ${sellerId} AND (links.flags & ${Prisma.raw(String(DISPLAY_PRODUCT_REVIEWS_BIT))} != 0) AND ${column("product_review_stats", "reviews_count")} != 0 LIMIT 1`,
  );
  const values = row ? Object.values(row) : [];
  return [toI(values[0]), toI(values[1]), toI(values[2])];
}

// `seller.reputation_summary_enabled? ? { reputation: seller.seller_reputation_summary } : {}`: the key is
// present, possibly null, only while the flag is on.
export async function reputationProps(sellerId: bigint | number): Promise<{ reputation: ReputationSummary | null } | Record<string, never>> {
  if (!(await isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(sellerId))))) return {};
  return { reputation: buildReputationSummary(await reputationAggregate(sellerId)) };
}
