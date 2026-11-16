// Port of app/sidekiq/calculate_payout_numbers_worker.rb: last week's sales (Monday to Sunday in Los Angeles) are summed from the
// purchases index and stored in whole dollars for the homepage. A sum Ruby would carry through a Float past 2**53, or of a type the
// golden does not cover, hands back before the key is written, which is safe because the job overwrites it from scratch.
// Golden: __fixtures__/calculate-payout-numbers-worker.golden.json (scripts/golden/calculate-payout-numbers-worker.rb).
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { type JsonValue, RubyFloat } from "../../server/jobs/sidekiq/ruby-json.ts";
import {
  calendarDateInTimeZone,
  endOfDayIso8601,
  startOfDayIso8601,
  ZonedInstant,
} from "../../server/models/concerns/rails-time-zone.ts";
import { addDays, wday } from "../../server/models/concerns/ruby-time.ts";
import { PurchaseSearchService } from "../../server/search/purchase-search.ts";

import { aggregationValue, RubyNoMethodError } from "./calculate-sale-numbers-worker.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

const PREV_WEEK_PAYOUT_KEY = "homepage:prev_week_payout_usd";
// `in_time_zone("America/Los_Angeles")`; time-zones.generated.json is keyed by ActiveSupport's name for the same zone.
const LOS_ANGELES = "Pacific Time (US & Canada)";
const DAYS_IN_WEEK = 7;
const SUNDAY_OFFSET_FROM_MONDAY = 6;
const CENTS_PER_DOLLAR = 100n;

type PayoutNumbersRedis = { set(key: string, value: string): Promise<unknown> };
export type CalculatePayoutNumbersDeps = { redis: () => PayoutNumbersRedis };

// `now.prev_week` and `.end_of_week`: Monday 00:00:00 of last week to Sunday 23:59:59 of it, in Los Angeles.
function lastWeek(now: Date): { start: ZonedInstant; end: ZonedInstant } {
  const lastWeekDay = addDays(calendarDateInTimeZone(LOS_ANGELES, now), -DAYS_IN_WEEK);
  const monday = addDays(lastWeekDay, -((wday(lastWeekDay) + SUNDAY_OFFSET_FROM_MONDAY) % DAYS_IN_WEEK));
  const sunday = addDays(monday, SUNDAY_OFFSET_FROM_MONDAY);
  return {
    start: new ZonedInstant(startOfDayIso8601(LOS_ANGELES, monday.year, monday.month, monday.day)),
    end: new ZonedInstant(endOfDayIso8601(LOS_ANGELES, sunday.year, sunday.month, sunday.day)),
  };
}

// `(value / 100.to_d).to_i`: nil and a String have no `/`; a number is divided exactly and truncated toward zero.
function wholeDollars(value: JsonValue | undefined): bigint {
  if (value === undefined || value === null) throw new RubyNoMethodError("undefined method '/' for nil");
  if (typeof value === "string") throw new RubyNoMethodError("undefined method '/' for an instance of String");
  if (typeof value === "bigint") return value / CENTS_PER_DOLLAR;
  if (typeof value === "number" || value instanceof RubyFloat) {
    const raw = typeof value === "number" ? value : value.value;
    if (!Number.isFinite(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER)
      throw new HandBackToRuby("the sum is too large for a Float to carry exactly");
    return BigInt(Math.trunc(raw)) / CENTS_PER_DOLLAR;
  }
  throw new HandBackToRuby("the sum is not a number");
}

export const calculatePayoutNumbersWorkerWith = (
  deps: Partial<JobDeps> = {},
  numbers: Partial<CalculatePayoutNumbersDeps> = {},
) =>
  modelJob({ min: 0 }, async (_args, jobDeps) => {
    const { start, end } = lastWeek(jobDeps.now());
    const result = await PurchaseSearchService.process({
      price_greater_than: 0,
      state: "successful",
      size: 0,
      exclude_unreversed_chargedback: true,
      exclude_refunded: true,
      exclude_bundle_product_purchases: true,
      created_on_or_after: start,
      created_on_or_before: end,
      aggs: { total_made: { sum: { field: "price_cents" } } },
    });
    const totalMade = wholeDollars(aggregationValue(result.response.aggregations, "total_made"));

    const redis = (numbers.redis ?? (() => getRedis("main")))();
    await redis.set(PREV_WEEK_PAYOUT_KEY, totalMade.toString());
  })(deps);

export const calculatePayoutNumbersWorker = calculatePayoutNumbersWorkerWith();
