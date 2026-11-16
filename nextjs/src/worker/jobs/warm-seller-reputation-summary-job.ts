// Port of app/sidekiq/warm_seller_reputation_summary_job.rb and the part of
// app/modules/user/reputation_summary.rb it runs (warm_reputation_snapshot).
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";

import { relationCacheKeyWithVersion } from "../../server/cache/keys.ts";
import { railsCache, type RailsCache } from "../../server/cache/rails-cache.ts";
import { notifyError } from "../../server/infra/error-reporting.ts";
import { isFeatureEnabled, userActor } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import type { JobDeps } from "./support/job-deps.ts";
import { modelJob } from "./support/job-deps.ts";

export const REPUTATION_SUMMARY_FEATURE = "seller_reputation_summary";
const CACHE_PREFIX = "seller_reputation_summary";
const CACHE_VERSION = "v2";
const CACHE_TTL_SECONDS = 10 * 60;
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;
// Link flag 17 (display_product_reviews); flag_shih_tzu numbers bits from 1.
const DISPLAY_PRODUCT_REVIEWS_BIT = 1 << 16;

const versionKey = (userId: unknown) => `${CACHE_PREFIX}/version/${String(userId)}`;
const snapshotKey = (userId: unknown) => `${CACHE_PREFIX}/${CACHE_VERSION}/snapshot/${String(userId)}`;

// String#to_i on what Redis GET returned (nil.to_i is 0).
function rubyToI(value: string | null): number {
  const match = value === null ? null : /^\s*[+-]?\d+(?:_\d+)*/u.exec(value);
  return match ? Number.parseInt(match[0].replaceAll("_", ""), 10) : 0;
}

// Numeric#to_i on a COUNT/SUM column (Integer, BigDecimal or nil).
function toI(value: unknown): number {
  if (value == null) return 0;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).trunc().toNumber();
  return Math.trunc(Number(value));
}

// MAX(updated_at) as Time#to_fs(:usec) needs it. A Date only carries milliseconds; a string from
// the driver keeps the column's microseconds.
function maxUpdatedAt(value: unknown): { time: Date; micros?: number } | null {
  if (value == null) return null;
  if (value instanceof Date) return { time: value };
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/u.exec(String(value));
  if (!match) throw new Error(`unexpected MAX(updated_at): ${String(value)}`);
  const [, y, mo, d, h, mi, s, frac] = match;
  return { time: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)), micros: Number((frac ?? "").padEnd(6, "0")) };
}

export type ReputationDeps = { redis: () => Redis; cache: () => RailsCache };
const defaultReputationDeps: ReputationDeps = { redis: () => getRedis("main"), cache: railsCache };

export function warmSellerReputationSummaryJobWith(overrides: Partial<JobDeps & ReputationDeps> = {}) {
  const { redis, cache } = { ...defaultReputationDeps, ...overrides };
  return modelJob({ min: 1 }, async ([userId], deps) => {
    const [user] = await selectRows<{ id: unknown }>(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
    if (!user) return;
    if (!(await isFeatureEnabled(REPUTATION_SUMMARY_FEATURE, userActor(String(user.id)), { redis: redis() }))) return;

    // reputation_summary_cache_signature: an unreadable version is reported and skips the warm.
    let signature: number;
    try {
      signature = rubyToI(await redis().get(versionKey(user.id)));
    } catch (error) {
      notifyError(error, { user_id: user.id });
      return;
    }

    // products.cache_key_with_version
    const [lifecycle] = await selectRows<{ size: unknown; timestamp: unknown }>(
      Prisma.sql`SELECT COUNT(*) AS ${Prisma.raw("`size`")}, MAX(${column("links", "updated_at")}) AS timestamp FROM ${table("links")} WHERE ${column("links", "user_id")} = ${user.id}`,
    );
    const productsSql = `SELECT \`links\`.* FROM \`links\` WHERE \`links\`.\`user_id\` = ${String(user.id)}`;
    const lifecycleKey = relationCacheKeyWithVersion("links", productsSql, toI(lifecycle?.size), maxUpdatedAt(lifecycle?.timestamp));

    const key = `${CACHE_PREFIX}/${CACHE_VERSION}/${String(user.id)}/${lifecycleKey}/${signature}`;
    const aggregate = await cache().fetch(key, { expiresIn: CACHE_TTL_SECONDS }, async () => {
      const [row] = await selectRows<unknown[]>(
        Prisma.sql`SELECT COUNT(*), SUM(reviews_count), SUM(ratings_of_five_count * 5 + ratings_of_four_count * 4 + ratings_of_three_count * 3 + ratings_of_two_count * 2 + ratings_of_one_count) FROM ${table("links")} FORCE INDEX (index_links_on_user_id) STRAIGHT_JOIN product_review_stats ON product_review_stats.link_id = links.id WHERE ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "draft")} = FALSE AND ${column("links", "user_id")} = ${user.id} AND (links.flags & ${Prisma.raw(String(DISPLAY_PRODUCT_REVIEWS_BIT))} != 0) AND ${column("product_review_stats", "reviews_count")} != 0 LIMIT 1`,
      );
      const values = row ? Object.values(row) : [];
      return [toI(values[0]), toI(values[1]), toI(values[2])];
    });

    const computedAt = Math.floor(deps.now().getTime() / 1000);
    await redis().set(snapshotKey(user.id), JSON.stringify({ aggregate, signature, computed_at: computedAt }), "EX", SNAPSHOT_TTL_SECONDS);
  })(overrides);
}

export const warmSellerReputationSummaryJob = warmSellerReputationSummaryJobWith();
