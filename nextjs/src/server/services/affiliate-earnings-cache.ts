// Port of app/services/affiliate_earnings_cache.rb, the background half: what RefreshAffiliateEarningsJob calls
// (`refresh_unless_fresh!` and `release_computation!`) and the Affiliate#total_cents_earned sum under a time limit.
// The request half (`fetch`, which also enqueues the job) is not ported.
// Golden: worker/jobs/__fixtures__/refresh-affiliate-earnings-job.golden.json (scripts/golden/refresh-affiliate-earnings-job.rb).
import { Prisma } from "@prisma/client";

import { MarshalRefusedError, type MarshalValue, RubySymbol, RubyTimeWithZone } from "../cache/marshal.ts";
import { type RailsCache, railsCache } from "../cache/rails-cache.ts";
import { HandBackToRuby } from "../jobs/hand-back.ts";
import { selectRows } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";

const SECONDS_PER_MINUTE = 60;
export const CACHE_TTL_SECONDS = 24 * 60 * SECONDS_PER_MINUTE;
export const STALE_AFTER_SECONDS = 5 * SECONDS_PER_MINUTE;
export const BACKGROUND_TIMEOUT_MS = 15 * SECONDS_PER_MINUTE * 1000;
// (BACKGROUND_TIMEOUT_MS / 1_000).seconds + 5.minutes
export const BACKGROUND_HANDOFF_LOCK_TTL_SECONDS = BACKGROUND_TIMEOUT_MS / 1000 + 5 * SECONDS_PER_MINUTE;

export type AffiliateEarningsDeps = {
  // Time.current
  now: () => RubyTimeWithZone;
  cache: () => RailsCache;
};

export const defaultAffiliateEarningsDeps: AffiliateEarningsDeps = {
  now: () => RubyTimeWithZone.fromMilliseconds(Date.now()),
  cache: railsCache,
};

export const cacheKey = (affiliateId: bigint) => `affiliate/${affiliateId}/total_cents_earned`;
export const computeLockKey = (affiliateId: bigint) => `${cacheKey(affiliateId)}/computing`;
export const backgroundRunLockKey = (affiliateId: bigint) => `${cacheKey(affiliateId)}/refreshing`;

// The same SQL as `purchases.paid.not_chargedback_or_chargedback_reversed`; chargeback_reversed is flag bit 512.
// `pick` of the hinted expression: the hint has to sit right after SELECT.
function totalCentsEarnedSql(affiliateId: bigint, timeoutMs: number): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(`SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ COALESCE(SUM(purchases.affiliate_credit_cents), 0) FROM \`purchases\` WHERE \`purchases\`.\`affiliate_id\` = `)}${affiliateId}${Prisma.raw(
    " AND `purchases`.`purchase_state` = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) LIMIT 1",
  )}`;
}

// A hash entry by symbol key; `value[:cents]`.
function symbolEntry(hash: Map<MarshalValue, MarshalValue>, name: string): { found: boolean; value: MarshalValue } {
  for (const [key, value] of hash) if (key instanceof RubySymbol && key.name === name) return { found: true, value };
  return { found: false, value: null };
}

type Cached = { computedAt: MarshalValue };

// `read`: the cached hash when it holds a :cents key (a zero is a good answer). A value Node cannot decode is another process's.
async function read(deps: AffiliateEarningsDeps, affiliateId: bigint): Promise<Cached | null> {
  let value: MarshalValue | undefined;
  try {
    value = await deps.cache().read(cacheKey(affiliateId));
  } catch (error) {
    if (error instanceof MarshalRefusedError)
      throw new HandBackToRuby(`the cached value is outside the Marshal subset: ${error.message}`);
    throw error;
  }
  if (!(value instanceof Map)) return null;
  if (!symbolEntry(value, "cents").found) return null;
  return { computedAt: symbolEntry(value, "computed_at").value };
}

const nanoseconds = (time: RubyTimeWithZone) => BigInt(time.seconds) * 1_000_000_000n + BigInt(time.nanoseconds);

// `computed_at.blank? || computed_at < STALE_AFTER.ago`
function stale(cached: Cached, now: RubyTimeWithZone): boolean {
  const { computedAt } = cached;
  if (computedAt === null || computedAt === false) return true;
  // Ruby compares any other class with TimeWithZone#<=> and raises; nothing but this service writes the key.
  if (!(computedAt instanceof RubyTimeWithZone)) throw new HandBackToRuby("the cached computed_at is not a time");
  return nanoseconds(computedAt) < nanoseconds(now) - BigInt(STALE_AFTER_SECONDS) * 1_000_000_000n;
}

// A SUM(integer) is a DECIMAL(32, 0), which mysql2 reads as an Integer.
function integerFrom(value: unknown): number | bigint {
  const integer = BigInt(String(value instanceof Prisma.Decimal ? value.toFixed(0) : value));
  return Number.isSafeInteger(Number(integer)) ? Number(integer) : integer;
}

async function totalCentsEarned(affiliateId: bigint, timeoutMs: number): Promise<number | bigint> {
  const [row] = await selectRows<Record<string, unknown>>(totalCentsEarnedSql(affiliateId, timeoutMs));
  return integerFrom(row ? Object.values(row)[0] : 0);
}

const claimBackgroundRun = (deps: AffiliateEarningsDeps, affiliateId: bigint) =>
  deps.cache().write(backgroundRunLockKey(affiliateId), true, {
    expiresIn: BACKGROUND_HANDOFF_LOCK_TTL_SECONDS,
    unlessExist: true,
  });

const claimForBackgroundRun = (deps: AffiliateEarningsDeps, affiliateId: bigint) =>
  deps.cache().write(computeLockKey(affiliateId), true, { expiresIn: BACKGROUND_HANDOFF_LOCK_TTL_SECONDS });

const releaseBackgroundRun = (deps: AffiliateEarningsDeps, affiliateId: bigint) =>
  deps.cache().delete(backgroundRunLockKey(affiliateId));

// `release_computation!`: hands the computation back to the request path.
export const releaseComputation = (deps: AffiliateEarningsDeps, affiliateId: bigint) =>
  deps.cache().delete(computeLockKey(affiliateId));

// `refresh!`: the sum with the background time limit, cached with the time it was computed.
async function refresh(deps: AffiliateEarningsDeps, affiliateId: bigint): Promise<void> {
  const cents = await totalCentsEarned(affiliateId, BACKGROUND_TIMEOUT_MS);
  await deps.cache().write(
    cacheKey(affiliateId),
    new Map<MarshalValue, MarshalValue>([
      [new RubySymbol("cents"), cents],
      [new RubySymbol("computed_at"), deps.now()],
    ]),
    { expiresIn: CACHE_TTL_SECONDS },
  );
}

// `refresh_unless_fresh!`. The cache read is the only step before the first write, and the one that can hand the run back.
export async function refreshUnlessFresh(deps: AffiliateEarningsDeps, affiliateId: bigint): Promise<void> {
  const cached = await read(deps, affiliateId);
  if (cached && !stale(cached, deps.now())) return;
  // Somebody else is computing it: their claim, not ours, governs what requests see.
  if (!(await claimBackgroundRun(deps, affiliateId))) return;

  try {
    await claimForBackgroundRun(deps, affiliateId);
    await refresh(deps, affiliateId);
    await releaseComputation(deps, affiliateId);
  } catch (error) {
    // The retry stays the owner of the computation: re-arm the claim a request would otherwise take.
    await claimForBackgroundRun(deps, affiliateId);
    throw error;
  } finally {
    await releaseBackgroundRun(deps, affiliateId);
  }
}

// The Affiliate STI classes with a model: any other `type` makes ActiveRecord raise SubclassNotFound.
const AFFILIATE_TYPES = new Set(["DirectAffiliate", "GlobalAffiliate", "Collaborator"]);

export function assertAffiliateType(type: unknown): void {
  if (typeof type !== "string" || !AFFILIATE_TYPES.has(type))
    throw new NotPortedError("Affiliate", `its type ${JSON.stringify(type)} is not an Affiliate class`);
}
