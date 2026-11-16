// CreatorAnalytics::ProductPageViews (app/services/creator_analytics/product_page_views.rb): the composite
// aggregations over the product_page_views index behind the analytics charts' views.
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import { hourKeyOf } from "./d3.ts";
import { addDays, dayStartIso, timezoneId } from "./civil-time.ts";
import { ES_MAX_BUCKET_SIZE, MAX_HOURLY_DATE_RANGE_DAYS, VALID_INTERVALS, type SalesUser } from "./creator-analytics-sales.ts";
import type { JsonValue } from "./es-json.ts";
import { RubyError } from "./ruby-params.ts";
import { isNotFound } from "./transport.ts";

type Bucket = { key: Record<string, unknown>; doc_count: number };

const presence = (value: unknown): string | null => (typeof value === "string" && /[^\s]/u.test(value) ? value : null);

export class CreatorAnalyticsProductPageViews {
  private readonly iana: string;
  private readonly query: JsonValue;
  private readonly interval: string;

  // `dates`: civil dates, first to last.
  constructor(user: SalesUser, products: { id: number | bigint }[], dates: string[], interval: string = "day") {
    this.interval = interval;
    if (!(VALID_INTERVALS as readonly string[]).includes(interval)) throw new RubyError("ArgumentError", `interval must be one of: ${VALID_INTERVALS.join(", ")}`);
    const first = dates[0]!;
    const last = dates.at(-1)!;
    const days = Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000);
    if (interval === "hour" && days > MAX_HOURLY_DATE_RANGE_DAYS) {
      throw new RubyError("ArgumentError", `date range cannot exceed ${MAX_HOURLY_DATE_RANGE_DAYS} days for the hour interval`);
    }
    this.iana = timezoneId(user.timezone);
    this.query = {
      bool: {
        filter: [{ terms: { product_id: products.map((product) => Number(product.id)) } }],
        must: [{ range: { timestamp: { gte: dayStartIso(first, this.iana), lt: dayStartIso(addDays(last, 1), this.iana) } } }],
      },
    };
  }

  // [product_id, date] => views. At a DST fall-back the same local hour occurs twice: add, don't overwrite.
  async byProductAndDate(): Promise<Map<string, number>> {
    const buckets = await this.paginate([{ product_id: { terms: { field: "product_id" } } }, this.dateHistogramSource()]);
    return this.sum(buckets, (bucket) => [bucket.key.product_id as number, this.bucketDateKey(bucket)]);
  }

  // [product_id, country, state] => views; a blank country or state is nil.
  async byProductAndCountryAndState(): Promise<{ key: [number, string | null, string | null]; count: number }[]> {
    const buckets = await this.paginate([
      { product_id: { terms: { field: "product_id" } } },
      { country: { terms: { field: "country", missing_bucket: true } } },
      { state: { terms: { field: "state", missing_bucket: true } } },
    ]);
    const result = new Map<string, { key: [number, string | null, string | null]; count: number }>();
    for (const bucket of buckets) {
      const key: [number, string | null, string | null] = [bucket.key.product_id as number, presence(bucket.key.country), presence(bucket.key.state)];
      result.set(JSON.stringify(key), { key, count: bucket.doc_count });
    }
    return [...result.values()];
  }

  // [product_id, referrer_domain, date] => views
  async byProductAndReferrerAndDate(): Promise<Map<string, number>> {
    const buckets = await this.paginate([{ product_id: { terms: { field: "product_id" } } }, { referrer_domain: { terms: { field: "referrer_domain" } } }, this.dateHistogramSource()]);
    return this.sum(buckets, (bucket) => [bucket.key.product_id as number, bucket.key.referrer_domain as string, this.bucketDateKey(bucket)]);
  }

  private sum(buckets: Bucket[], keyOf: (bucket: Bucket) => unknown[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const bucket of buckets) {
      const key = JSON.stringify(keyOf(bucket));
      result.set(key, (result.get(key) ?? 0) + bucket.doc_count);
    }
    return result;
  }

  private dateHistogramSource(): JsonValue {
    const histogram: Record<string, JsonValue> = { time_zone: this.iana, field: "timestamp", calendar_interval: this.interval };
    // Hourly buckets are keyed by epoch milliseconds and formatted by bucketDateKey.
    if (this.interval !== "hour") histogram.format = "yyyy-MM-dd";
    return { date: { date_histogram: histogram } };
  }

  // `Time.at(value.to_i / 1000).in_time_zone(timezone).strftime("%Y-%m-%dT%H:%M")` for an hour.
  private bucketDateKey(bucket: Bucket): string {
    const value = bucket.key.date as string | number;
    return this.interval === "hour" ? hourKeyOf(Math.trunc(Number(value) / 1000) * 1000, this.iana) : (value as string);
  }

  private async paginate(sources: JsonValue[]): Promise<Bucket[]> {
    const composite: Record<string, JsonValue> = { size: ES_MAX_BUCKET_SIZE, sources };
    const body = { query: this.query, size: 0, timeout: "60s", aggs: { composite_agg: { composite } } };
    const buckets: Bucket[] = [];
    try {
      for (;;) {
        const { body: response } = await search({ index: indexName("ProductPageView"), body: body as unknown as JsonValue });
        const aggregation = (response as { aggregations: { composite_agg: { buckets: Bucket[]; after_key?: JsonValue } } }).aggregations.composite_agg;
        buckets.push(...aggregation.buckets);
        if (aggregation.buckets.length < ES_MAX_BUCKET_SIZE) return buckets;
        composite.after = aggregation.after_key as JsonValue;
      }
    } catch (error) {
      // A missing index reads as no views.
      if (isNotFound(error)) return [];
      throw error;
    }
  }
}
