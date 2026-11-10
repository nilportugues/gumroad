// CreatorAnalytics::Churn and its DateWindow, ProductScope, ElasticsearchFetcher and DatasetBuilder
// (app/services/creator_analytics/churn*): churn, new and active subscriber counts per product and day.
// A large seller's ranges are cached in ComputedSalesAnalyticsDay.
import type { User } from "@prisma/client";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { readDataFromKeys, upsertDataFromKey } from "../../models/computed-sales-analytics-day.ts";
import { isLargeSeller } from "../../models/large-seller.ts";
import { LinkFlags } from "../../models/link.ts";
import { rubyFloatRoundDigits } from "../../models/concerns/ruby-numeric.ts";
import { indexName } from "../../infra/elasticsearch.ts";
import { search } from "../../search/api.ts";
import { addDays, civilDateInZone, dayStartIso, timezoneId } from "../../search/civil-time.ts";
import { RubyFloat, type JsonValue } from "../../search/es-json.ts";
import { CHARGED_SALES_SEARCH_OPTIONS, ES_MAX_BUCKET_SIZE } from "../../search/creator-analytics-sales.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { externalId, rackParam, type QuerySource } from "../audience/support.ts";
import { sellerAnalyticsCacheVersion } from "./caching-proxy.ts";
import { firstSaleCreatedAtForAnalytics, productsForCreatorAnalytics, sellerDate, sellerToday } from "./seller-analytics.ts";

const DEFAULT_RANGE_DAYS = 30;
type Seller = Pick<User, "id" | "timezone" | "created_at">;
type ProductInfo = { id: number; external_id: string; permalink: string; name: string };
export type DateWindow = { startDate: string; endDate: string };

// ProductScope: the seller's recurring-billing or tiered-membership products among those analytics lists.
async function subscriptionProducts(seller: Seller): Promise<ProductInfo[]> {
  const products = await productsForCreatorAnalytics(BigInt(seller.id));
  return products
    .filter((product) => LinkFlags.isSet(product.flags, "is_recurring_billing") || LinkFlags.isSet(product.flags, "is_tiered_membership"))
    .map((product) => ({ id: Number(product.id), external_id: externalId(product.id), permalink: product.unique_permalink!, name: product.name! }));
}

async function earliestAnalyticsDate(seller: Seller): Promise<string> {
  const firstSale = await firstSaleCreatedAtForAnalytics(BigInt(seller.id));
  return firstSale ? sellerDate(seller, firstSale) : sellerDate(seller, seller.created_at!);
}

// Date.parse for the shapes the date range picker sends. Anything Ruby might read differently is Rails' to answer.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;
const DATE_WORD = /sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/iu;

// ChurnController#parse_date: `Date.parse(date.to_s)`, nil when Ruby raises Date::Error.
export function parseRailsDate(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return parseRailsArrayDate(value);
  const text = value ?? "";
  if (!/\d/u.test(text) && !DATE_WORD.test(text)) return null;
  const match = ISO_DATE.exec(text);
  if (!match) throw new HandBackToRails();
  const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // An impossible date is a Date::Error for a bare date; with a time part Ruby may read it differently.
  if (probe.getUTCMonth() !== Number(match[2]) - 1 || probe.getUTCDate() !== Number(match[3])) {
    if (text.length === 10) return null;
    throw new HandBackToRails();
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// `Date.parse(array.to_s)` reads the array's inspect string. Plain printable elements with no digit and no day or
// month name leave Date._parse nothing to find (a Date::Error, so nil); anything else is Rails' to answer.
function parseRailsArrayDate(values: string[]): null {
  if (values.every((item) => /^[ -~]*$/u.test(item) && !item.includes("\\") && !/\d/u.test(item) && !DATE_WORD.test(item))) return null;
  throw new HandBackToRails();
}

export function churnParams(query: QuerySource): { startDate: string | null; endDate: string | null } {
  return { startDate: parseRailsDate(rackParam(query, "from")), endDate: parseRailsDate(rackParam(query, "to")) };
}

const clamp = (value: string, min: string, max: string) => (value < min ? min : value > max ? max : value);

// DateWindow: ranges are clamped between the seller's first day of analytics and today.
function dateWindow(seller: Seller, earliest: string, startDate: string | null, endDate: string | null, now: Date): DateWindow {
  const latest = sellerToday(seller, now);
  const start = clamp(startDate ?? addDays(latest, -DEFAULT_RANGE_DAYS), earliest, latest);
  // `end_value.clamp(clamped_start, latest)`
  const end = clamp(endDate ?? latest, start, latest);
  return { startDate: start, endDate: end };
}

const daysOf = (window: DateWindow): string[] => {
  const dates: string[] = [];
  for (let date = window.startDate; date <= window.endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
};

const monthKeysOf = (dates: string[]): string[] => [...new Set(dates.map((date) => `${date.slice(0, 7)}-01`))];

type Bucket = { key: { product_id: number; date?: string }; [aggregate: string]: unknown };

// ElasticsearchFetcher
export class Fetcher {
  private readonly seller: { id: number | bigint; timezone: string | null };
  private readonly productIds: number[];
  private readonly window: DateWindow;

  constructor(seller: { id: number | bigint; timezone: string | null }, productIds: number[], window: DateWindow) {
    this.seller = seller;
    this.productIds = productIds;
    this.window = window;
  }

  private get iana() {
    return timezoneId(this.seller.timezone);
  }

  private baseQuery(): { bool: Record<string, JsonValue[]> } {
    const query = structuredClone(new PurchaseSearchService(CHARGED_SALES_SEARCH_OPTIONS).body.query) as unknown as { bool: Record<string, JsonValue[]> };
    query.bool.filter ??= [];
    query.bool.must ??= [];
    query.bool.filter.push({ term: { seller_id: this.seller.id } }, { terms: { product_id: this.productIds } });
    query.bool.must.push({ term: { selected_flags: "is_original_subscription_purchase" } });
    return query;
  }

  private dayRange(field: string): JsonValue {
    return { range: { [field]: { gte: dayStartIso(this.window.startDate, this.iana), lt: dayStartIso(addDays(this.window.endDate, 1), this.iana) } } };
  }

  private sources(field: string): JsonValue[] {
    return [
      { product_id: { terms: { field: "product_id" } } },
      { date: { date_histogram: { field, calendar_interval: "day", format: "yyyy-MM-dd", time_zone: this.iana } } },
    ];
  }

  private async paginate(query: unknown, sources: JsonValue[], aggs: JsonValue): Promise<Bucket[]> {
    const composite: Record<string, JsonValue> = { size: ES_MAX_BUCKET_SIZE, sources };
    const body = { query, size: 0, aggs: { composite_agg: { composite, aggs } } };
    const buckets: Bucket[] = [];
    for (;;) {
      const { body: response } = await search({ index: indexName("Purchase"), body: body as unknown as JsonValue });
      const aggregation = (response as { aggregations: { composite_agg: { buckets: Bucket[]; after_key?: JsonValue } } }).aggregations.composite_agg;
      buckets.push(...aggregation.buckets);
      if (aggregation.buckets.length < ES_MAX_BUCKET_SIZE) return buckets;
      composite.after = aggregation.after_key as JsonValue;
    }
  }

  private value = (bucket: Bucket, name: string): number => Math.trunc(((bucket[name] as { value?: number } | undefined)?.value ?? 0) as number);

  async churnEvents(): Promise<Map<string, { churned_count: number; revenue_lost_cents: number }>> {
    const query = this.baseQuery();
    query.bool.must!.push({ exists: { field: "subscription_cancelled_at" } });
    query.bool.filter!.push(this.dayRange("subscription_cancelled_at"));
    const aggs = { churned_customers: { cardinality: { field: "subscription_id" } }, revenue_lost_cents: { sum: { field: "monthly_recurring_revenue" } } };
    const buckets = await this.paginate(query, this.sources("subscription_cancelled_at"), aggs);
    return new Map(buckets.map((bucket) => [`${bucket.key.product_id}|${bucket.key.date}`, { churned_count: this.value(bucket, "churned_customers"), revenue_lost_cents: this.value(bucket, "revenue_lost_cents") }]));
  }

  async newSubscriptions(): Promise<Map<string, number>> {
    const query = this.baseQuery();
    query.bool.filter!.push(this.dayRange("created_at"));
    const buckets = await this.paginate(query, this.sources("created_at"), { new_customers: { cardinality: { field: "subscription_id" } } });
    return new Map(buckets.map((bucket) => [`${bucket.key.product_id}|${bucket.key.date}`, this.value(bucket, "new_customers")]));
  }

  async initialActiveCounts(): Promise<Map<number, number>> {
    const query = this.baseQuery();
    const boundary = dayStartIso(this.window.startDate, this.iana);
    query.bool.filter!.push({ range: { created_at: { lt: boundary } } });
    query.bool.should = [{ bool: { must_not: { exists: { field: "subscription_deactivated_at" } } } }, { range: { subscription_deactivated_at: { gt: boundary } } }];
    (query.bool as Record<string, unknown>).minimum_should_match = 1;
    const buckets = await this.paginate(query, [{ product_id: { terms: { field: "product_id" } } }], { active_subscribers: { cardinality: { field: "subscription_id" } } });
    return new Map(buckets.map((bucket) => [bucket.key.product_id, this.value(bucket, "active_subscribers")]));
  }
}

type Stat = { churn_rate: number; churned_customers_count: number; revenue_lost_cents: number; subscriber_base: number };

// `((numerator.to_f / denominator) * 100).round(2)`, 0.0 without a denominator.
const computeRate = (numerator: number, denominator: number): number => (denominator > 0 ? rubyFloatRoundDigits((numerator / denominator) * 100, 2) : 0);

type Series = {
  window: DateWindow;
  products: ProductInfo[];
  churnEvents: Map<string, { churned_count: number; revenue_lost_cents: number }>;
  newSubscriptions: Map<string, number>;
  initialActive: Map<number, number>;
};

// DatasetBuilder#build
function buildDataset({ window, products, churnEvents, newSubscriptions, initialActive }: Series) {
  const dates = daysOf(window);
  const running = new Map(initialActive);
  type ProductMonth = { churned: number; revenue: number; active_start: number | null; new_subscriptions: number };
  const months = new Map<string, { by_product: Map<string, ProductMonth>; total: { churned: number; revenue: number; active_start: number; new_subscriptions: number } }>();
  const month = (key: string) => {
    if (!months.has(key)) months.set(key, { by_product: new Map(), total: { churned: 0, revenue: 0, active_start: 0, new_subscriptions: 0 } });
    return months.get(key)!;
  };
  const daily: Record<string, { by_product: Record<string, Stat>; total: Stat }> = {};

  for (const date of dates) {
    const monthKey = `${date.slice(0, 7)}-01`;
    const totals = { churned: 0, revenue: 0, denominator: 0 };
    const byProduct: Record<string, Stat> = {};
    const entry = month(monthKey);

    for (const product of products) {
      const newCount = newSubscriptions.get(`${product.id}|${date}`) ?? 0;
      const churn = churnEvents.get(`${product.id}|${date}`) ?? { churned_count: 0, revenue_lost_cents: 0 };
      const activeBase = running.get(product.id) ?? 0;
      const denominator = activeBase + newCount;
      byProduct[product.permalink] = {
        churn_rate: computeRate(churn.churned_count, denominator),
        churned_customers_count: churn.churned_count,
        revenue_lost_cents: churn.revenue_lost_cents,
        subscriber_base: denominator,
      };

      if (!entry.by_product.has(product.permalink)) entry.by_product.set(product.permalink, { churned: 0, revenue: 0, active_start: null, new_subscriptions: 0 });
      const monthProduct = entry.by_product.get(product.permalink)!;
      if (monthProduct.active_start === null) {
        monthProduct.active_start = activeBase;
        entry.total.active_start += activeBase;
      }
      monthProduct.new_subscriptions += newCount;
      entry.total.new_subscriptions += newCount;

      totals.churned += churn.churned_count;
      totals.revenue += churn.revenue_lost_cents;
      totals.denominator += denominator;
      monthProduct.churned += churn.churned_count;
      monthProduct.revenue += churn.revenue_lost_cents;

      running.set(product.id, Math.max(activeBase + newCount - churn.churned_count, 0));
    }

    daily[date] = {
      by_product: byProduct,
      total: { churn_rate: computeRate(totals.churned, totals.denominator), churned_customers_count: totals.churned, revenue_lost_cents: totals.revenue, subscriber_base: totals.denominator },
    };
    entry.total.churned += totals.churned;
    entry.total.revenue += totals.revenue;
  }

  const monthly: Record<string, { by_product: Record<string, Stat>; total: Stat }> = {};
  for (const monthKey of monthKeysOf(dates)) {
    const entry = month(monthKey);
    const byProduct: Record<string, Stat> = {};
    for (const product of products) {
      // `monthly_product_data[permalink]` creates the entry when the month never saw the product.
      const perProduct = entry.by_product.get(product.permalink) ?? { churned: 0, revenue: 0, active_start: null, new_subscriptions: 0 };
      const denominator = (perProduct.active_start ?? 0) + perProduct.new_subscriptions;
      byProduct[product.permalink] = { churn_rate: computeRate(perProduct.churned, denominator), churned_customers_count: perProduct.churned, revenue_lost_cents: perProduct.revenue, subscriber_base: denominator };
    }
    const denominator = entry.total.active_start + entry.total.new_subscriptions;
    monthly[monthKey] = {
      by_product: byProduct,
      total: { churn_rate: computeRate(entry.total.churned, denominator), churned_customers_count: entry.total.churned, revenue_lost_cents: entry.total.revenue, subscriber_base: denominator },
    };
  }

  // summary_payload
  const churned = new Map<number, number>();
  const revenue = new Map<number, number>();
  const added = new Map<number, number>();
  for (const [key, value] of churnEvents) {
    const id = Number(key.split("|")[0]);
    churned.set(id, (churned.get(id) ?? 0) + value.churned_count);
    revenue.set(id, (revenue.get(id) ?? 0) + value.revenue_lost_cents);
  }
  for (const [key, value] of newSubscriptions) {
    const id = Number(key.split("|")[0]);
    added.set(id, (added.get(id) ?? 0) + value);
  }
  const summaryTotals = { churned: 0, revenue: 0, subscriber_base: 0 };
  const summaryByProduct: Record<string, Stat> = {};
  for (const product of products) {
    const productChurned = churned.get(product.id) ?? 0;
    const productRevenue = revenue.get(product.id) ?? 0;
    const denominator = (initialActive.get(product.id) ?? 0) + (added.get(product.id) ?? 0);
    summaryByProduct[product.permalink] = { churn_rate: computeRate(productChurned, denominator), churned_customers_count: productChurned, revenue_lost_cents: productRevenue, subscriber_base: denominator };
    summaryTotals.churned += productChurned;
    summaryTotals.revenue += productRevenue;
    summaryTotals.subscriber_base += denominator;
  }

  return {
    metadata: {
      start_date: window.startDate,
      end_date: window.endDate,
      products: products.map(({ external_id, permalink, name }) => ({ external_id, permalink, name })),
    },
    data: {
      daily,
      monthly,
      summary: {
        total: { churn_rate: computeRate(summaryTotals.churned, summaryTotals.subscriber_base), churned_customers_count: summaryTotals.churned, revenue_lost_cents: summaryTotals.revenue, subscriber_base: summaryTotals.subscriber_base },
        by_product: summaryByProduct,
      },
    },
  };
}

async function series(seller: Seller, products: ProductInfo[], window: DateWindow): Promise<Series> {
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return { window, products, churnEvents: new Map(), newSubscriptions: new Map(), initialActive: new Map() };
  const fetcher = new Fetcher(seller, ids, window);
  return { window, products, churnEvents: await fetcher.churnEvents(), newSubscriptions: await fetcher.newSubscriptions(), initialActive: await fetcher.initialActiveCounts() };
}

const CACHE_CUTOFF_DAYS = 2;

// `cache_key_for(date_window)`
async function cacheKeyFor(seller: Seller, window: DateWindow): Promise<string> {
  return ["creator_analytics_churn", "payload", `v${await sellerAnalyticsCacheVersion()}`, `seller_${seller.id}`, seller.timezone, window.startDate, window.endDate].join(":");
}

// churn_rate is a Float in Rails, and the stored document keeps it so (`1.0`, not `1`).
const FLOAT_KEYS = new Set(["churn_rate"]);
function withRubyFloats(value: unknown, key?: string): JsonValue {
  if (Array.isArray(value)) return value.map((item) => withRubyFloats(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withRubyFloats(item, name)]));
  return key !== undefined && FLOAT_KEYS.has(key) && typeof value === "number" ? new RubyFloat(value) : (value as JsonValue);
}
function withoutRubyFloats(value: JsonValue): unknown {
  if (value instanceof RubyFloat) return value.value;
  if (Array.isArray(value)) return value.map(withoutRubyFloats);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withoutRubyFloats(item)]));
  return value;
}

// CreatorAnalytics::Churn#generate_data. A large seller's ranges that ended at least two days ago are read from
// and written to ComputedSalesAnalyticsDay.
export async function churnData(seller: Seller, params: { startDate: string | null; endDate: string | null }, now: Date = new Date()) {
  const products = await subscriptionProducts(seller);
  const earliest = await earliestAnalyticsDate(seller);
  const current = dateWindow(seller, earliest, params.startDate, params.endDate, now);
  const cacheable = (await isLargeSeller(seller.id)) && current.endDate <= addDays(sellerToday(seller, now), -CACHE_CUTOFF_DAYS);
  const cacheKey = cacheable ? await cacheKeyFor(seller, current) : null;
  if (cacheKey !== null) {
    const [stored] = (await readDataFromKeys([cacheKey])).values();
    if (stored) return withoutRubyFloats(stored as JsonValue) as Awaited<ReturnType<typeof payloadOf>>;
  }
  const payload = await payloadOf(seller, products, earliest, current, now);
  if (cacheKey !== null) await upsertDataFromKey(cacheKey, withRubyFloats(payload));
  return payload;
}

async function payloadOf(seller: Seller, products: ProductInfo[], earliest: string, current: DateWindow, now: Date) {
  const currentPayload = buildDataset(await series(seller, products, current));

  // build_previous_date_window
  const length = daysOf(current).length;
  const previousEnd = addDays(current.startDate, -1);
  const previousStart = addDays(previousEnd, -(length - 1));
  const previous = previousStart < earliest ? null : dateWindow(seller, earliest, previousStart, previousEnd, now);
  const previousPayload = previous ? buildDataset(await series(seller, products, previous)) : null;

  const period = (window: DateWindow) => ({ start_date: window.startDate, end_date: window.endDate });
  return {
    metadata: {
      current_period: period(current),
      previous_period: previous ? period(previous) : null,
      products: currentPayload.metadata.products,
    },
    data: { current_period: currentPayload.data, previous_period: previousPayload?.data ?? null },
  };
}

export { civilDateInZone };
