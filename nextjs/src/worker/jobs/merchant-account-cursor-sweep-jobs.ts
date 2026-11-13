// Ports of the two cursor sweeps over merchant accounts, up to the Stripe reads: SweepClosedSellerConnectAccountsJob (closed sellers'
// Stripe accounts) and AlertOnStripeDobDriftJob (date-of-birth drift). Each reads a page of candidates after a Redis cursor, wraps to
// the start once the page is empty, and walks the page against Stripe. A run with no candidate finishes here; one with candidates
// needs the Stripe reads and the cursor write that precedes them, so it is handed back before anything is written. A wrap that finds
// candidates hands back too: the cursor reset is left to Rails.
// Golden: __fixtures__/closed-seller-connect-sweep-jobs.golden.json (scripts/golden/closed-seller-connect-sweep-jobs.rb).
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { selectRows } from "../../server/models/sql.ts";

import { checkArity } from "./arity.ts";
import type { JobHandler } from "./types.ts";

// RedisKey.closed_seller_connect_sweep_cursor, RedisKey.stripe_dob_drift_sweep_cursor
const CLOSED_SELLER_CURSOR_KEY = "closed_seller_connect_sweep:cursor";
const DOB_DRIFT_CURSOR_KEY = "stripe_dob_drift_sweep:cursor";
// SweepClosedSellerConnectAccountsJob::MAX_ACCOUNTS_PER_RUN, AlertOnStripeDobDriftJob::MAX_CANDIDATES_SCANNED
const MAX_ACCOUNTS_PER_RUN = 30;
const MAX_CANDIDATES_SCANNED = 400;

type CursorRedis = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> };
export type CursorSweepDeps = { redis: () => CursorRedis };
const defaultDeps: CursorSweepDeps = { redis: () => getRedis("main") as unknown as CursorRedis };

// String#to_i: a leading integer (signed, underscores between digits), 0 for anything else, no size limit.
const RUBY_INTEGER = /^\s*([+-]?\d+(?:_\d+)*)/u;
const rubyToI = (value: string | null): bigint => {
  const match = RUBY_INTEGER.exec(value ?? "");
  return match ? BigInt(match[1]!.replaceAll("_", "")) : 0n;
};

// `current_cursor`: a Redis failure is reported and reads as 0.
async function currentCursor(redis: CursorRedis, key: string): Promise<bigint> {
  try {
    return rubyToI(await redis.get(key));
  } catch (error) {
    notifyError(error);
    return 0n;
  }
}

type Sweep = {
  cursorKey: string;
  candidates: (afterId: bigint) => Promise<unknown[]>;
};

const sweepJobWith =
  (sweep: Sweep, overrides: Partial<CursorSweepDeps> = {}): JobHandler =>
  async (args) => {
    checkArity(args, 0);
    const redis = { ...defaultDeps, ...overrides }.redis();
    const afterId = await currentCursor(redis, sweep.cursorKey);
    const candidates = await sweep.candidates(afterId);
    if (candidates.length > 0) throw new HandBackToRuby("the page of candidates is walked against Stripe");
    if (afterId > 0n) {
      // Exhausted the population: wrap, unless the first page is not empty, which Rails walks.
      if ((await sweep.candidates(0n)).length > 0)
        throw new HandBackToRuby("the wrapped page is walked against Stripe");
      try {
        await redis.set(sweep.cursorKey, "0");
      } catch (error) {
        notifyError(error);
      }
    }
  };

const STRIPE_CONNECT_ACCOUNT_IDS = Prisma.raw(
  "SELECT `merchant_accounts`.`id` FROM `merchant_accounts` WHERE `merchant_accounts`.`charge_processor_id` = 'stripe' AND (json_data->>'$.meta.stripe_connect' = 'true') AND `merchant_accounts`.`user_id` IS NOT NULL",
);

// The cursor reaches the SQL as a quoted string, as Rails writes it for `where("id > ?", cursor)`.
const closedSellerCandidates = (afterId: bigint) =>
  selectRows(
    Prisma.sql`SELECT \`merchant_accounts\`.* FROM \`merchant_accounts\` WHERE \`merchant_accounts\`.\`charge_processor_id\` = ${"stripe"} AND \`merchant_accounts\`.\`user_id\` IN (SELECT \`users\`.\`id\` FROM \`users\` WHERE \`users\`.\`deleted_at\` IS NOT NULL) AND \`merchant_accounts\`.\`charge_processor_merchant_id\` IS NOT NULL AND \`merchant_accounts\`.\`charge_processor_deleted_at\` IS NULL AND \`merchant_accounts\`.\`id\` NOT IN (${STRIPE_CONNECT_ACCOUNT_IDS}) AND (json_data->>'$.retired_by_adoption_at' IS NULL) AND (merchant_accounts.id > ${String(afterId)}) ORDER BY \`merchant_accounts\`.\`id\` ASC LIMIT ${Prisma.raw(String(MAX_ACCOUNTS_PER_RUN + 1))}`,
  );

const dobDriftCandidates = (afterId: bigint) =>
  selectRows(
    Prisma.sql`SELECT \`merchant_accounts\`.* FROM \`merchant_accounts\` WHERE \`merchant_accounts\`.\`deleted_at\` IS NULL AND \`merchant_accounts\`.\`charge_processor_alive_at\` IS NOT NULL AND \`merchant_accounts\`.\`charge_processor_deleted_at\` IS NULL AND \`merchant_accounts\`.\`charge_processor_id\` = ${"stripe"} AND \`merchant_accounts\`.\`user_id\` IS NOT NULL AND (merchant_accounts.id > ${String(afterId)}) AND \`merchant_accounts\`.\`id\` NOT IN (${STRIPE_CONNECT_ACCOUNT_IDS}) ORDER BY \`merchant_accounts\`.\`id\` ASC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
  );

const CLOSED_SELLER_SWEEP: Sweep = {
  cursorKey: CLOSED_SELLER_CURSOR_KEY,
  candidates: closedSellerCandidates,
};
const DOB_DRIFT_SWEEP: Sweep = {
  cursorKey: DOB_DRIFT_CURSOR_KEY,
  candidates: dobDriftCandidates,
};

export const sweepClosedSellerConnectAccountsJobWith = (overrides: Partial<CursorSweepDeps> = {}) =>
  sweepJobWith(CLOSED_SELLER_SWEEP, overrides);
export const alertOnStripeDobDriftJobWith = (overrides: Partial<CursorSweepDeps> = {}) =>
  sweepJobWith(DOB_DRIFT_SWEEP, overrides);

export const sweepClosedSellerConnectAccountsJob = sweepClosedSellerConnectAccountsJobWith();
export const alertOnStripeDobDriftJob = alertOnStripeDobDriftJobWith();
