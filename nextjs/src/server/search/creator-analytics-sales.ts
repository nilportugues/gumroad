// CreatorAnalytics::Sales (app/services/creator_analytics/sales.rb): the composite aggregations behind the
// analytics charts and the dashboard's best sellers, over PurchaseSearchService's charged-sales query.
// Proven by creator-analytics.golden.json (request bytes and answers recorded from the real Ruby).
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import { addDays, dayStartIso, timezoneId } from "./civil-time.ts";
import type { JsonValue } from "./es-json.ts";
import { PurchaseSearchService } from "./purchase-search.ts";
import { RubyError } from "./ruby-params.ts";

// ES_MAX_BUCKET_SIZE
export const ES_MAX_BUCKET_SIZE = 65_535;
export const VALID_INTERVALS = ["day", "hour"] as const;
export type Interval = (typeof VALID_INTERVALS)[number];
export const MAX_HOURLY_DATE_RANGE_DAYS = 7;

// Purchase::CHARGED_SALES_SEARCH_OPTIONS
export const CHARGED_SALES_SEARCH_OPTIONS = {
  state: ["preorder_authorization_successful", "successful", "preorder_concluded_successfully"],
  exclude_giftees: true,
  exclude_refunded: true,
  exclude_unreversed_chargedback: true,
  exclude_non_successful_preorder_authorizations: true,
  exclude_bundle_product_purchases: true,
  exclude_commission_completion_purchases: true,
};

// CreatorAnalytics::Sales::SEARCH_OPTIONS
const SEARCH_OPTIONS = { ...CHARGED_SALES_SEARCH_OPTIONS, exclude_refunded: false, exclude_unreversed_chargedback: false };

export type SalesUser = { id: number | bigint; timezone: string | null };
export type Total = { count: number; total: number };
export type Entry<K> = { key: K; value: Total };

type Bucket = { key: Record<string, unknown>; doc_count: number; total: { value: number | null } };
type Query = { bool: Record<string, JsonValue[]> };

// Time#strftime("%Y-%m-%dT%H:%M") of an epoch-millisecond bucket key, in the zone.
export function hourKey(epochMs: number, iana: string): string {
  const seconds = Math.trunc(epochMs / 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(seconds * 1000));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:00`;
}

export class CreatorAnalyticsSales {
  private readonly iana: string;
  private readonly query: Query;
  private readonly interval: Interval;

  // `dates`: civil dates (YYYY-MM-DD), first to last. `products: null` filters on the seller instead of a list of ids.
  constructor(user: SalesUser, dates: string[], products: { id: number | bigint }[] | null = null, interval: string = "day") {
    if (!(VALID_INTERVALS as readonly string[]).includes(interval)) throw new RubyError("ArgumentError", `interval must be one of: ${VALID_INTERVALS.join(", ")}`);
    const first = dates[0]!;
    const last = dates.at(-1)!;
    // (dates.last - dates.first).to_i
    const days = Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000);
    if (interval === "hour" && days > MAX_HOURLY_DATE_RANGE_DAYS) {
      throw new RubyError("ArgumentError", `date range cannot exceed ${MAX_HOURLY_DATE_RANGE_DAYS} days for the hour interval`);
    }
    this.interval = interval as Interval;
    this.iana = timezoneId(user.timezone);
    const options = products === null ? { ...SEARCH_OPTIONS, seller: { id: Number(user.id) } } : SEARCH_OPTIONS;
    this.query = new PurchaseSearchService(options).body.query as unknown as Query;
    if (products !== null) (this.query.bool.filter ??= []).push({ terms: { product_id: products.map((product) => Number(product.id)) } });
    // CreatorAnalytics::DateQuery.day_range
    (this.query.bool.must ??= []).push({ range: { created_at: { gte: dayStartIso(first, this.iana), lt: dayStartIso(addDays(last, 1), this.iana) } } });
  }

  async byProductAndDate(): Promise<Entry<[number, string]>[]> {
    const buckets = await this.paginate([{ product_id: { terms: { field: "product_id" } } }, this.dateHistogramSource()]);
    return this.merge(buckets, (bucket) => [bucket.key.product_id as number, this.bucketDateKey(bucket)]);
  }

  async byProductAndCountryAndState(): Promise<Entry<[number, string | null, string | null]>[]> {
    const sources: JsonValue[] = [
      { product_id: { terms: { field: "product_id" } } },
      { country: { terms: { field: "ip_country", missing_bucket: true } } },
      { state: { terms: { field: "ip_state", missing_bucket: true } } },
    ];
    const buckets = await this.paginate(sources);
    const presence = (value: unknown) => (typeof value === "string" && /[^\s]/u.test(value) ? value : null);
    // Later buckets with the same key replace earlier ones (Hash#[]=).
    const result = new Map<string, Entry<[number, string | null, string | null]>>();
    for (const bucket of buckets) {
      const key: [number, string | null, string | null] = [bucket.key.product_id as number, presence(bucket.key.country), presence(bucket.key.state)];
      result.set(JSON.stringify(key), { key, value: { count: bucket.doc_count, total: Math.trunc(bucket.total.value ?? 0) } });
    }
    return [...result.values()];
  }

  async byProductAndReferrerAndDate(): Promise<Entry<[number, string, string]>[]> {
    const sources: JsonValue[] = [{ product_id: { terms: { field: "product_id" } } }, { referrer_domain: { terms: { field: "referrer_domain" } } }, this.dateHistogramSource()];
    const buckets = await this.paginate(sources);
    return this.merge(buckets, (bucket) => [bucket.key.product_id as number, bucket.key.referrer_domain as string, this.bucketDateKey(bucket)]);
  }

  // At a DST fall-back the same local hour occurs twice: the second bucket is added to the first.
  private merge<K extends unknown[]>(buckets: Bucket[], keyOf: (bucket: Bucket) => K): Entry<K>[] {
    const result = new Map<string, Entry<K>>();
    for (const bucket of buckets) {
      const key = keyOf(bucket);
      const count = bucket.doc_count;
      const total = Math.trunc(bucket.total.value ?? 0);
      const existing = result.get(JSON.stringify(key));
      if (existing) result.set(JSON.stringify(key), { key, value: { count: existing.value.count + count, total: existing.value.total + total } });
      else result.set(JSON.stringify(key), { key, value: { count, total } });
    }
    return [...result.values()];
  }

  private dateHistogramSource(): JsonValue {
    const histogram: Record<string, JsonValue> = { time_zone: this.iana, field: "created_at", calendar_interval: this.interval };
    // Hourly buckets are keyed by epoch milliseconds and formatted here.
    if (this.interval !== "hour") histogram.format = "yyyy-MM-dd";
    return { date: { date_histogram: histogram } };
  }

  private bucketDateKey(bucket: Bucket): string {
    const value = bucket.key.date as string | number;
    return this.interval === "hour" ? hourKey(Number(value), this.iana) : (value as string);
  }

  private async paginate(sources: JsonValue[]): Promise<Bucket[]> {
    const composite: Record<string, JsonValue> = { size: ES_MAX_BUCKET_SIZE, sources };
    const body = { query: this.query, size: 0, timeout: "60s", aggs: { composite_agg: { composite, aggs: AGGREGATIONS } } };
    const buckets: Bucket[] = [];
    for (;;) {
      const { body: response } = await search({ index: indexName("Purchase"), body: body as unknown as JsonValue });
      const aggregation = (response as { aggregations: { composite_agg: { buckets: Bucket[]; after_key?: JsonValue } } }).aggregations.composite_agg;
      buckets.push(...aggregation.buckets);
      if (aggregation.buckets.length < ES_MAX_BUCKET_SIZE) return buckets;
      composite.after = aggregation.after_key as JsonValue;
    }
  }
}

const AGGREGATIONS: JsonValue = {
  price_cents_total: { sum: { field: "price_cents" } },
  amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } },
  chargedback_agg: {
    filter: { term: { not_chargedback_or_chargedback_reversed: false } },
    aggs: { price_cents_total: { sum: { field: "price_cents" } }, amount_refunded_cents_total: { sum: { field: "amount_refunded_cents" } } },
  },
  total: {
    bucket_script: {
      buckets_path: {
        price_cents_total: "price_cents_total",
        amount_refunded_cents_total: "amount_refunded_cents_total",
        chargedback_price_cents_total: "chargedback_agg>price_cents_total",
        chargedback_amount_refunded_cents_total: "chargedback_agg>amount_refunded_cents_total",
      },
      // Refunds already removed from gross must not be removed again by a chargeback.
      script: "params.price_cents_total - params.amount_refunded_cents_total - params.chargedback_price_cents_total + params.chargedback_amount_refunded_cents_total",
    },
  },
};
