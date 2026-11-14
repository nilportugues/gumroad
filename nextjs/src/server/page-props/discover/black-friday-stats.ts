// BlackFridayStatsService.calculate_stats, without the 10-minute Rails.cache: the figures are what Rails computes on a
// cache miss, so a Rails process that cached them a few minutes ago can show an older total.
import { Prisma } from "@prisma/client";

import { rubyRound } from "../../models/concerns/ruby-numeric.ts";
import {
  NON_GIFT_SUCCESS_STATES,
  NOT_RECURRING_CHARGE,
  normalizeTiers,
  purchaseFlag,
  states,
  tiersOf,
} from "../../models/offer-code.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError as ModelNotPortedError } from "../../models/user.ts";
import { NotPortedError } from "../not-ported.ts";

export type BlackFridayStats = {
  active_deals_count: number;
  revenue_cents: number;
  average_discount_percentage: number;
};

type OfferCodeRow = {
  id: number | bigint;
  valid_at: Date | null;
  expires_at: Date | null;
  amount_percentage: number | null;
  ownership_duration_tiers: unknown;
};

// The page's filter hands back on its own NotPortedError, not the model layer's.
function tiersOfCode(raw: unknown) {
  try {
    return normalizeTiers(tiersOf(raw));
  } catch (error) {
    if (error instanceof ModelNotPortedError) throw new NotPortedError(error.message);
    throw error;
  }
}

export async function blackFridayStats(code: string, now: Date): Promise<BlackFridayStats> {
  const offerCodes = await selectRows<OfferCodeRow>(
    Prisma.sql`SELECT ${column("offer_codes", "id")}, ${column("offer_codes", "valid_at")}, ${column("offer_codes", "expires_at")}, ${column("offer_codes", "amount_percentage")}, ${column("offer_codes", "ownership_duration_tiers")} FROM ${table("offer_codes")} WHERE ${column("offer_codes", "code")} = ${code} AND ${column("offer_codes", "deleted_at")} IS NULL`,
  );
  // OfferCode#inactive?
  const active = offerCodes.filter(
    (offerCode) =>
      !(
        (offerCode.valid_at !== null && offerCode.valid_at.getTime() > now.getTime()) ||
        (offerCode.expires_at !== null && offerCode.expires_at.getTime() < now.getTime())
      ),
  );
  // A tiered code keeps its percentages in the tiers and leaves amount_percentage at a placeholder; `filter_map`
  // drops the nil of a fixed-amount code but keeps a 0.
  const percentages = active.flatMap((offerCode) => {
    const tiers = tiersOfCode(offerCode.ownership_duration_tiers);
    if (tiers.length > 0) return [Math.max(...tiers.map((tier) => tier.amount_percentage))];
    return offerCode.amount_percentage === null ? [] : [Number(offerCode.amount_percentage)];
  });

  // Includes codes that have expired: revenue already earned still counts.
  let revenue = 0;
  if (offerCodes.length > 0) {
    const [row] = await selectRows<{ revenue: Prisma.Decimal | number | bigint | null }>(
      Prisma.sql`SELECT COALESCE(SUM(${column("purchases", "price_cents")}), 0) AS revenue FROM ${table("purchases")} WHERE ${column("purchases", "offer_code_id")} IN (${Prisma.join(offerCodes.map((offerCode) => offerCode.id))}) AND ${states(NON_GIFT_SUCCESS_STATES)} AND ${NOT_RECURRING_CHARGE} AND ${purchaseFlag("is_archived_original_subscription_purchase", false)}`,
    );
    revenue = Number(row?.revenue ?? 0);
  }

  return {
    active_deals_count: active.length,
    revenue_cents: revenue,
    average_discount_percentage:
      percentages.length === 0 ? 0 : rubyRound(percentages.reduce((sum, value) => sum + value, 0) / percentages.length),
  };
}
