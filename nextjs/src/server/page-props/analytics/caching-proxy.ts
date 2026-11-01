// CreatorAnalytics::CachingProxy (app/services/creator_analytics/caching_proxy.rb): the cached values of
// CreatorAnalyticsWeb#by_(date|state|referral) for large sellers, merged with whatever is missing.
/* eslint-disable @typescript-eslint/no-explicit-any -- the days are JSON documents read back from the cache */
import { getRedis } from "../../infra/redis.ts";
import { isLargeSeller } from "../../models/large-seller.ts";
import { readDataFromKeys } from "../../models/computed-sales-analytics-day.ts";
import { addDays, civilDateInZone, timezoneId } from "../../search/civil-time.ts";
import { formattedDateWithTimezone } from "../../search/d3.ts";
import { RubyError } from "../../search/ruby-params.ts";
import { mergeDataByDate, mergeDataByReferral, mergeDataByState } from "./caching-proxy-formatters.ts";
import { CreatorAnalyticsWeb, type AnalyticsSeller } from "./creator-analytics-web.ts";
import { firstSaleCreatedAtForAnalytics, productsForCreatorAnalytics, type AnalyticsProduct } from "./seller-analytics.ts";

export const REFERRAL_CACHE_VERSION = 1;
export const REVENUE_CACHE_VERSION = 1;
// RedisKey.seller_analytics_cache_version
export const SELLER_ANALYTICS_CACHE_VERSION_KEY = "seller_analytics:cache_version";

export type AnalyticsKind = "date" | "state" | "referral";
type Day = Record<string, any>;

// Date#clamp
function clamp(value: string, min: string, max: string): string {
  if (min > max) throw new RubyError("ArgumentError", "min argument must be less than or equal to max argument");
  return value < min ? min : value > max ? max : value;
}

const range = (first: string, last: string): string[] => {
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) dates.push(date);
  return dates;
};

// `$redis.get(RedisKey.seller_analytics_cache_version) || 0`
export async function sellerAnalyticsCacheVersion(): Promise<string | number> {
  return (await getRedis("main").get(SELLER_ANALYTICS_CACHE_VERSION_KEY)) ?? 0;
}

export class CreatorAnalyticsCachingProxy {
  private readonly user: AnalyticsSeller;
  private readonly now: () => Date;
  private userCacheKeyValue: string | null = null;

  constructor(user: AnalyticsSeller, now: () => Date = () => new Date()) {
    this.user = user;
    this.now = now;
  }

  // `data_for_dates(start_date, end_date, by:)`; dates are civil dates.
  async dataForDates(startDate: string, endDate: string, by: AnalyticsKind = "date"): Promise<Day> {
    const dates = this.requestedDates(startDate, endDate);
    if (!(await isLargeSeller(this.user.id))) return await this.analyticsData(dates[0]!, dates.at(-1)!, by);

    const dataForDates = await this.fetchDataForDates(dates, by);
    const compiled = await this.compileDataForDatesAndFillMissing(dataForDates, by);
    if (by === "date") return mergeDataByDate(compiled);
    if (by === "state") return mergeDataByState(compiled);
    const firstSale = await firstSaleCreatedAtForAnalytics(BigInt(this.user.id));
    const iana = timezoneId(this.user.timezone);
    return mergeDataByReferral(compiled, dates, this.todayDate(), firstSale ? formattedDateWithTimezone(firstSale, iana, this.now()) : null);
  }

  // Today, from the user's time zone point of view.
  private todayDate(): string {
    return civilDateInZone(this.now().getTime(), timezoneId(this.user.timezone));
  }

  // `cache_key_for_data`
  private async cacheKeyForData(date: string, by: AnalyticsKind): Promise<string> {
    const key = `${await this.userCacheKey()}_by_${by}_for_${date}_revenue_v${REVENUE_CACHE_VERSION}`;
    return by === "referral" ? `${key}_v${REFERRAL_CACHE_VERSION}` : key;
  }

  // Bumping RedisKey.seller_analytics_cache_version invalidates every cached day.
  private async userCacheKey(): Promise<string> {
    this.userCacheKeyValue ??= `seller_analytics_v${await sellerAnalyticsCacheVersion()}_user_${this.user.id}_${this.user.timezone}`;
    return this.userCacheKeyValue;
  }

  // Constrains the range coming from the browser: not before the user's creation date, not after today, at least one day.
  private requestedDates(startDate: string, endDate: string): string[] {
    const today = this.todayDate();
    const createdDate = civilDateInZone(this.user.created_at!.getTime(), timezoneId(this.user.timezone));
    const start = clamp(startDate, createdDate, today);
    const end = clamp(endDate, start, today);
    return range(start, end);
  }

  private async analyticsData(startDate: string, endDate: string, by: AnalyticsKind, products: AnalyticsProduct[] | null = null): Promise<Day> {
    const web = new CreatorAnalyticsWeb(this.user, range(startDate, endDate), products);
    return (by === "date" ? await web.byDate() : by === "state" ? await web.byState() : await web.byReferral()) as Day;
  }

  // The stored data of every date, or null where missing, in the dates' order.
  private async fetchDataForDates(dates: string[], by: AnalyticsKind): Promise<[string, Day | null][]> {
    const keys = await Promise.all(dates.map((date) => this.cacheKeyForData(date, by)));
    const stored = await readDataFromKeys(keys);
    return dates.map((date, index) => [date, (stored.get(keys[index]!) as Day | null) ?? null]);
  }

  // `find_missing_date_ranges`: contiguous missing dates as [first, last].
  private missingDateRanges(data: [string, Day | null][]): [string, string][] {
    const ranges: [string, string][] = [];
    for (const [date, value] of data) {
      if (value) continue;
      const open = ranges.find(([, last]) => last === addDays(date, -1));
      if (open) open[1] = date;
      else ranges.push([date, date]);
    }
    return ranges;
  }

  // Takes { date => data | nil }, returns the data of every day. The product list is loaded once and shared by
  // every missing range of the request.
  private async compileDataForDatesAndFillMissing(data: [string, Day | null][], by: AnalyticsKind): Promise<Day[]> {
    const missing = this.missingDateRanges(data);
    const products = missing.length > 0 ? await productsForCreatorAnalytics(BigInt(this.user.id)) : null;
    const days: Day[] = [];
    for (const [date, day] of data) {
      if (day) {
        days.push(day);
        continue;
      }
      const missingRange = missing.find(([first]) => first === date);
      if (missingRange) days.push(await this.analyticsData(missingRange[0], missingRange[1], by, products));
    }
    return days;
  }
}
