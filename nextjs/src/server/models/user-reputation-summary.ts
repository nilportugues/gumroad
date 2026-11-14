// Port of User::ReputationSummary#seller_reputation_summary (app/modules/user/reputation_summary.rb), without
// exclude_product or snapshot_only: those belong to the product page, which reads a Redis snapshot and queues a job.
// The SQL is the aggregate Rails caches under a key that moves with every write that could change it, so reading
// it directly answers the same.
import { Prisma } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getRedis } from "../infra/redis.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

import { performAsync } from "./concerns/job-runtime.ts";
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

// `seller.seller_reputation_summary` for a seller whose flag is on.
export async function sellerReputationSummary(sellerId: bigint | number): Promise<ReputationSummary | null> {
  return buildReputationSummary(await reputationAggregate(sellerId));
}

// `seller.reputation_summary_enabled? ? { reputation: seller.seller_reputation_summary } : {}`: the key is
// present, possibly null, only while the flag is on.
export async function reputationProps(sellerId: bigint | number): Promise<{ reputation: ReputationSummary | null } | Record<string, never>> {
  if (!(await isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(sellerId))))) return {};
  return { reputation: buildReputationSummary(await reputationAggregate(sellerId)) };
}

const CACHE_PREFIX = "seller_reputation_summary";
const CACHE_VERSION = "v2";
// User::ReputationSummary::CACHE_TTL: an older snapshot is still rendered, but queues its refresh.
const CACHE_TTL_SECONDS = 10 * 60;
const WARM_JOB = "WarmSellerReputationSummaryJob";

type Aggregate = readonly [number, number, number];
type ProductRow = {
  id: bigint | number;
  flags: bigint | number | null;
  draft: boolean | number | null;
  deleted_at: Date | null;
};

type Snapshot = { aggregate: Aggregate | null; signature: number; computed_at: number };

function parseSnapshot(raw: string): Snapshot {
  let parsed: Partial<Snapshot> | null;
  try {
    parsed = JSON.parse(raw) as Partial<Snapshot> | null;
  } catch {
    throw new NotPortedError("User#seller_reputation_summary with an unreadable snapshot");
  }
  if (typeof parsed?.computed_at !== "number" || typeof parsed.signature !== "number")
    throw new NotPortedError("User#seller_reputation_summary with a snapshot of another shape");
  return { aggregate: parsed.aggregate ?? null, signature: parsed.signature, computed_at: parsed.computed_at };
}

// subtract_product: a product leaves the rollup only if it counted in the aggregate.
async function subtractProduct(aggregate: Aggregate, product: ProductRow): Promise<Aggregate> {
  const [stat] = await selectRows<Record<string, number>>(
    Prisma.sql`SELECT * FROM ${table("product_review_stats")} WHERE ${column("product_review_stats", "link_id")} = ${product.id} LIMIT 1`,
  );
  const displays = (BigInt(product.flags ?? 0) & BigInt(DISPLAY_PRODUCT_REVIEWS_BIT)) !== 0n;
  if (!stat || stat.reviews_count === 0 || !displays || product.deleted_at !== null || Boolean(Number(product.draft)))
    return aggregate;
  const [products, total, weighted] = aggregate;
  const ratings =
    stat.ratings_of_five_count! * 5 +
    stat.ratings_of_four_count! * 4 +
    stat.ratings_of_three_count! * 3 +
    stat.ratings_of_two_count! * 2 +
    stat.ratings_of_one_count!;
  return [products - 1, total - stat.reviews_count!, weighted - ratings];
}

// `seller.reputation_summary_enabled? ? { seller_reputation: seller.seller_reputation_summary(exclude_product: product, snapshot_only: true) } : {}`.
// The snapshot is the JSON the warm job stored in Redis, current while its signature is the seller's review-stat version. A missing,
// stale or old one queues WarmSellerReputationSummaryJob; `afterRender` collects that push so a page handed back to Rails afterwards
// does not make it.
export async function sellerReputationProps(
  seller: { id: bigint | number },
  product: ProductRow,
  afterRender: (() => Promise<void>)[] | undefined,
  now: Date = new Date(),
): Promise<{ seller_reputation: ReputationSummary | null } | Record<string, never>> {
  if (!(await isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(seller.id))))) return {};
  const [raw, version] = await getRedis("main").mget(
    `${CACHE_PREFIX}/${CACHE_VERSION}/snapshot/${seller.id}`,
    `${CACHE_PREFIX}/version/${seller.id}`,
  );
  const snapshot = raw == null ? null : parseSnapshot(raw);
  // String#to_i of the version key, 0 when it is missing
  const current = snapshot !== null && snapshot.signature === (Number.parseInt(version ?? "", 10) || 0);
  if (snapshot === null || !current || snapshot.computed_at <= Math.floor(now.getTime() / 1000) - CACHE_TTL_SECONDS)
    afterRender?.push(async () => void (await performAsync(WARM_JOB, [Number(seller.id)])));
  const aggregate = current ? snapshot.aggregate : null;
  if (aggregate === null) return { seller_reputation: null };
  return { seller_reputation: buildReputationSummary(await subtractProduct(aggregate, product)) };
}
