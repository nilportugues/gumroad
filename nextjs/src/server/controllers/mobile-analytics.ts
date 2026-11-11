// Api::Mobile::AnalyticsController: the creator app's sales charts. In `data_by_date` a purchase the creator-app serializer does not reproduce throws NotPortedError, which hands the request to Rails.
/* eslint-disable @typescript-eslint/no-explicit-any -- the days are JSON documents, as in the caching proxy */
import { formattedDollarAmount } from "../models/concerns/currency-helper.ts";
import { CreatorAnalyticsCachingProxy } from "../page-props/analytics/caching-proxy.ts";
import { CreatorAnalyticsWeb } from "../page-props/analytics/creator-analytics-web.ts";
import {
  countProductsForCreatorAnalytics,
  productIdsForCreatorAnalytics,
} from "../page-props/analytics/seller-analytics.ts";
import { creatorAppPurchasesJson } from "../presenters/mobile-serializer-reads.ts";
import { addDays, civilDateInZone, dayStartIso, timezoneId, TimeZoneNotPortedError } from "../search/civil-time.ts";
import { MAX_HOURLY_DATE_RANGE_DAYS, CHARGED_SALES_SEARCH_OPTIONS } from "../search/creator-analytics-sales.ts";
import { RubyFloat } from "../search/es-json.ts";
import { PurchaseSearchService } from "../search/purchase-search.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMobile, renderJson, type MobileAuth, type MobileInput } from "./mobile-api.ts";

const CREATOR_API_SCOPES = ["creator_api"];
const MAX_BY_REFERRAL_DATE_RANGE_DAYS = 365;
// SellerMobileAnalyticsService::SALES_LIMIT
const SALES_LIMIT = 300;
const BAD_REQUEST = 400;
// GUMROAD_STARTED_DATE
const GUMROAD_STARTED_DATE = "2011-04-04";
// { "1d" => 0, "1w" => 6, "1m" => 29, "1y" => 364 }
const DATE_RANGE_OFFSETS: Record<string, number> = { "1d": 0, "1w": 6, "1m": 29, "1y": 364 };
const DEFAULT_RANGE_OFFSET = 29;
const DAYS_PER_WEEK = 7;
// Pagy::DEFAULT[:limit]
const PAGY_DEFAULT_LIMIT = 20;
const DIGITS = /^\d{1,9}$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

type Day = Record<string, any>;

// Date.parse of a bare ISO date; any other shape (or an impossible date) is Ruby's to read.
function parseDate(value: unknown): string {
  const match = typeof value === "string" ? ISO_DATE.exec(value) : null;
  if (!match) throw new HandBackToRails("a date Node does not parse");
  const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (probe.getUTCMonth() !== Number(match[2]) - 1 || probe.getUTCDate() !== Number(match[3]))
    throw new HandBackToRails("an impossible date");
  return value as string;
}

// AnalyticsController#set_date_range
function dateRange(params: MobileInput["params"], timezone: string | null): { startDate: string; endDate: string } {
  const today = civilDateInZone(Date.now(), timezoneId(timezone));
  if (params.date_range) {
    if (typeof params.date_range !== "string") throw new HandBackToRails("a date_range that is not a string");
    if (params.date_range === "all") return { startDate: GUMROAD_STARTED_DATE, endDate: today };
    const offset = DATE_RANGE_OFFSETS[params.date_range];
    // Hash#fetch raises KeyError for any other value.
    if (offset === undefined) throw new HandBackToRails("an unknown date_range");
    return { startDate: addDays(today, -offset), endDate: today };
  }
  if (params.start_date && params.end_date)
    return { startDate: parseDate(params.start_date), endDate: parseDate(params.end_date) };
  return { startDate: addDays(today, -DEFAULT_RANGE_OFFSET), endDate: today };
}

const rangeDates = (first: string, last: string): string[] => {
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) dates.push(date);
  return dates;
};

// CachingProxy::Formatters::Helpers#dates_and_months_to_days: the day label, with the year of its month unless asked to leave it out.
const daysOf = (datesAndMonths: Day[], withoutYears: boolean) =>
  datesAndMonths.map((entry) => (withoutYears ? entry.date : `${entry.date} ${/(\d{4})$/u.exec(entry.month)![1]}`));
const monthsOf = (datesAndMonths: Day[]) => [...new Set(datesAndMonths.map((entry) => entry.month as string))];

// ByDate#group_date_data_by_day and #group_date_data_by_month
function groupDateData(data: Day, by: "day" | "month"): Day {
  if (by === "day") return { dates: daysOf(data.dates_and_months, true), by_date: data.by_date };
  const monthsCount = data.dates_and_months.at(-1).month_index + 1;
  const permalinks = Object.keys(data.by_date.views);
  const grouped: Day = { views: {}, sales: {}, totals: {} };
  for (const type of ["views", "sales", "totals"])
    for (const permalink of permalinks) grouped[type][permalink] = new Array(monthsCount).fill(0);
  (data.dates_and_months as Day[]).forEach((entry, index) => {
    for (const type of ["views", "sales", "totals"])
      for (const permalink of permalinks)
        grouped[type][permalink][entry.month_index] += data.by_date[type][permalink][index];
  });
  return { dates: monthsOf(data.dates_and_months), by_date: grouped };
}

// ByReferral#group_referral_data_by_day and #group_referral_data_by_month
function groupReferralData(data: Day, by: "day" | "month"): Day {
  if (by === "day") return { dates: daysOf(data.dates_and_months, true), by_referral: data.by_referral };
  const monthsCount = data.dates_and_months.at(-1).month_index + 1;
  const types = ["views", "sales", "totals"];
  const grouped: Day = {};
  for (const type of types) {
    grouped[type] = {};
    for (const [permalink, referrers] of Object.entries<Day>(data.by_referral[type])) {
      grouped[type][permalink] = Object.fromEntries(
        Object.keys(referrers).map((referrer) => [referrer, new Array(monthsCount).fill(0)]),
      );
    }
  }
  (data.dates_and_months as Day[]).forEach((entry, index) => {
    for (const type of types)
      for (const [permalink, referrers] of Object.entries<Day>(data.by_referral[type]))
        for (const referrer of Object.keys(referrers))
          grouped[type][permalink][referrer][entry.month_index] += referrers[referrer][index];
  });
  return { dates: monthsOf(data.dates_and_months), by_referral: grouped };
}

const groupBy = (params: MobileInput["params"]): string => {
  const value = params.group_by ?? "day";
  if (typeof value !== "string") throw new HandBackToRails("a group_by that is not a string");
  return value;
};

async function byDate(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const owner = auth!.owner;
  const { startDate, endDate } = dateRange(input.params, owner.timezone);
  const iana = timezoneId(owner.timezone);
  let data: Day;
  const grouping = groupBy(input.params);
  try {
    if (input.params.group_by === "hour") {
      if (endDate < startDate) return renderJson({ error: "Invalid date range." }, BAD_REQUEST);
      if ((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > MAX_HOURLY_DATE_RANGE_DAYS) {
        return renderJson(
          { error: `Date range cannot exceed ${MAX_HOURLY_DATE_RANGE_DAYS} days for the hourly interval.` },
          BAD_REQUEST,
        );
      }
      const hourly = (await new CreatorAnalyticsWeb(
        owner,
        rangeDates(startDate, endDate),
        null,
        "hour",
      ).byDate()) as Day;
      data = { dates: hourly.dates_and_months.map((entry: Day) => entry.date), by_date: hourly.by_date };
    } else {
      const raw = (await new CreatorAnalyticsCachingProxy(owner).dataForDates(startDate, endDate, "date")) as Day;
      data = grouping === "day" || grouping === "month" ? groupDateData(raw, grouping) : raw;
    }
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
  return renderJson({ ...data, seller_time_zone: iana });
}

async function byState(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const owner = auth!.owner;
  const { startDate, endDate } = dateRange(input.params, owner.timezone);
  try {
    return renderJson(await new CreatorAnalyticsCachingProxy(owner).dataForDates(startDate, endDate, "state"));
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

async function byReferral(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const owner = auth!.owner;
  let { startDate } = dateRange(input.params, owner.timezone);
  const { endDate } = dateRange(input.params, owner.timezone);
  // clamp_date_range_for_by_referral
  if ((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > MAX_BY_REFERRAL_DATE_RANGE_DAYS)
    startDate = addDays(endDate, -MAX_BY_REFERRAL_DATE_RANGE_DAYS);
  const grouping = groupBy(input.params);
  try {
    const raw = (await new CreatorAnalyticsCachingProxy(owner).dataForDates(startDate, endDate, "referral")) as Day;
    return renderJson(grouping === "day" || grouping === "month" ? groupReferralData(raw, grouping) : raw);
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

// SellerMobileAnalyticsService#process with no fields: revenue and its formatted form for the seller's current day, week, month or year.
const BEGINNING_OF: Record<string, (today: string) => string> = {
  day: (today) => today,
  // Date#beginning_of_week starts the week on Monday.
  week: (today) => addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK)),
  month: (today) => `${today.slice(0, 8)}01`,
  year: (today) => `${today.slice(0, 5)}01-01`,
};

// `purchases` adds the newest SALES_LIMIT charged sales (narrowed by `query`) and `salesCount` their total, as `data_by_date` asks for both.
async function sellerMobileAnalytics(
  owner: MobileAuth["owner"],
  range: string,
  fields: { salesCount?: boolean; purchases?: { query: string | null } } = {},
) {
  const iana = timezoneId(owner.timezone);
  const options: Record<string, unknown> = {
    ...CHARGED_SALES_SEARCH_OPTIONS,
    seller: owner.id,
    exclude_refunded: false,
    exclude_unreversed_chargedback: false,
    size: 0,
    aggs: {
      price_cents_total: { sum: { field: "price_cents" } },
      amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
      chargedback_agg: {
        filter: { term: { not_chargedback_or_chargedback_reversed: false } },
        aggs: {
          price_cents_total: { sum: { field: "price_cents" } },
          amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
        },
      },
    },
    track_total_hits: fields.salesCount === true,
  };
  if (fields.purchases) {
    options.size = SALES_LIMIT;
    options.sort = [{ created_at: { order: "desc" } }, { id: { order: "desc" } }];
    if (fields.purchases.query) options.seller_query = fields.purchases.query;
  }
  if (range !== "all") {
    // `raise "Invalid range"` is a 500 in Rails, whose answer is not Node's to give.
    const beginning = BEGINNING_OF[range];
    if (!beginning) throw new HandBackToRails("a range Ruby rejects");
    options.created_on_or_after = new Date(dayStartIso(beginning(civilDateInZone(Date.now(), iana)), iana));
  }
  const result = await new PurchaseSearchService(options as never).process();
  const aggregations = result.response.aggregations as Record<string, any>;
  const revenue =
    aggregations.price_cents_total.value -
    aggregations.amount_refunded_cents_total.value -
    aggregations.chargedback_agg.price_cents_total.value +
    aggregations.chargedback_agg.amount_refunded_cents_total.value;
  const data: Record<string, unknown> = {
    revenue: new RubyFloat(revenue),
    formatted_revenue: formattedDollarAmount(Math.round(revenue)),
  };
  if (fields.salesCount) data.sales_count = result.total;
  if (fields.purchases) data.purchases = await creatorAppPurchasesJson(result.ids.map((id) => BigInt(id)));
  return data;
}

const revenueFor = (owner: MobileAuth["owner"], range: string) => sellerMobileAnalytics(owner, range);

async function dataByDate(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const { range, query } = input.params;
  if (typeof range !== "string") throw new HandBackToRails("a range that is not a string");
  if (query !== undefined && query !== null && typeof query !== "string")
    throw new HandBackToRails("a query that is not a string");
  try {
    return renderJson(
      await sellerMobileAnalytics(auth!.owner, range, { salesCount: true, purchases: { query: query ?? null } }),
    );
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

async function revenueTotals(_input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const owner = auth!.owner;
  try {
    const totals: Record<string, unknown> = {};
    for (const range of ["day", "week", "month", "year"]) totals[range] = await revenueFor(owner, range);
    return renderJson(totals);
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

// Pagy's `params[name].to_i` for plain digits; absent is the default, anything else is Ruby's (0 and "" raise there).
function pagyParam(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "string" && DIGITS.test(value) && Number(value) >= 1) return Number(value);
  throw new HandBackToRails(`a ${name} Node does not cast`);
}

// `pagy(products_for_creator_analytics, limit_max: nil, limit_param: :items)` with `Link#as_json(original: true, only: [:id])`, which is
// the row's integer id.
async function products(input: MobileInput, auth: MobileAuth | null): Promise<ActionResult> {
  const sellerId = BigInt(auth!.owner.id);
  const page = pagyParam(input.params.page, 1, "page");
  const items = pagyParam(input.params.items, PAGY_DEFAULT_LIMIT, "items");
  const count = await countProductsForCreatorAnalytics(sellerId);
  const pages = Math.max(Math.ceil(count / items), 1);
  // Api::Mobile::BaseController rescues Pagy::VariableError (config/initializers/pagy.rb sets overflow to :exception)
  if (page > pages)
    return {
      ...renderJson({ error: { message: `expected :page in 1..${pages}; got ${page}` } }, BAD_REQUEST),
      rescued: true,
    };
  const ids = await productIdsForCreatorAnalytics(sellerId, items, (page - 1) * items);
  return renderJson({
    products: ids.map((id) => ({ id: Number(id) })),
    meta: {
      pagination: {
        count,
        items,
        page,
        pages,
        prev: page > 1 ? page - 1 : null,
        next: page < pages ? page + 1 : null,
        last: pages,
      },
    },
  });
}

registerMobile(
  { method: "GET", pattern: "/mobile/analytics/products", scopes: CREATOR_API_SCOPES, run: products },
  { method: "GET", pattern: "/mobile/analytics/data_by_date", scopes: CREATOR_API_SCOPES, run: dataByDate },
  { method: "GET", pattern: "/mobile/analytics/by_date", scopes: CREATOR_API_SCOPES, run: byDate },
  { method: "GET", pattern: "/mobile/analytics/by_state", scopes: CREATOR_API_SCOPES, run: byState },
  { method: "GET", pattern: "/mobile/analytics/by_referral", scopes: CREATOR_API_SCOPES, run: byReferral },
  { method: "GET", pattern: "/mobile/analytics/revenue_totals", scopes: CREATOR_API_SCOPES, run: revenueTotals },
);
