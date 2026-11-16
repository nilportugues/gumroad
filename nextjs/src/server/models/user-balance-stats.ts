// UserBalanceStatsService (app/services/user_balance_stats_service.rb): the cached blob behind the dashboard's balance
// figures. Pure reads and the cache key: nothing here writes. Golden: __fixtures__/user-balance-stats.golden.json
// (scripts/golden/user-balance-stats.rb).
//
// Ported: `overview_stats` (the unpaid balance and the three sales totals) and the cache key and lifetime.
// Not ported: the payout periods (`next_payout_period_data`, `processing_payout_periods_data`), which PayoutsHelper#payout_period_data
// builds from the payout schedule, chargeback-rate reserves, payout processor details and ~30 purchase aggregates. Until they are,
// UpdateUserBalanceStatsCacheWorker hands every user back to Rails (worker/jobs/refund-payout-guard-jobs.ts).
import { Prisma } from "@prisma/client";

import { salesCentsTotal } from "../search/purchase-sales.ts";
import { ago } from "./concerns/ruby-time.ts";
import { column, selectRows, table } from "./sql.ts";

// `$redis.setex(cache_key, 48.hours.to_i, ...)`
export const BALANCE_STATS_CACHE_TTL_SECONDS = 48 * 3600;

const SEVEN_DAYS = { days: 7 } as const;
const TWENTY_EIGHT_DAYS = { days: 28 } as const;

// `cache_key`: v2, because the Payouts page reads is_current_period off the payload.
export const balanceStatsCacheKey = (userId: bigint | number) => `balance_stats_for_user_${userId}_v2`;

// `user.unpaid_balance_cents`: `balances.unpaid.sum(:amount_cents)`
export async function unpaidBalanceCents(userId: bigint | number): Promise<number> {
  const [row] = await selectRows<Record<string, bigint | number | Prisma.Decimal | null>>(
    Prisma.sql`SELECT SUM(${column("balances", "amount_cents")}) FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${userId} AND ${column("balances", "state")} = ${"unpaid"}`,
  );
  const sum = row === undefined ? null : Object.values(row)[0];
  return sum == null ? 0 : Number(sum.toString());
}

export type OverviewStats = { balance: number; last_seven_days_sales_total: number; last_28_days_sales_total: number; sales_cents_total: number };

// `overview_stats`: the dashboard renders only these four scalars.
export async function overviewStats(userId: bigint, now: Date): Promise<OverviewStats> {
  const balance = await unpaidBalanceCents(userId);
  const last_seven_days_sales_total = await salesCentsTotal(userId, { after: ago(SEVEN_DAYS, now) });
  const last_28_days_sales_total = await salesCentsTotal(userId, { after: ago(TWENTY_EIGHT_DAYS, now) });
  return { balance, last_seven_days_sales_total, last_28_days_sales_total, sales_cents_total: await salesCentsTotal(userId) };
}
