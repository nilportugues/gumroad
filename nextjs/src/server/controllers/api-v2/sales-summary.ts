// Api::V2::SalesSummary (app/services/api/v2/sales_summary.rb): the totals of a date range and, grouped, the breakdown behind
// GET /v2/sales/summary, from aggregations over the purchases index.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { indexName } from "../../infra/elasticsearch.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { search } from "../../search/api.ts";
import { addDays, dayStartIso, timezoneId } from "../../search/civil-time.ts";
import {
  CHARGED_SALES_SEARCH_OPTIONS,
  ES_MAX_BUCKET_SIZE,
  hourKey,
  MAX_HOURLY_DATE_RANGE_DAYS,
} from "../../search/creator-analytics-sales.ts";
import type { JsonValue } from "../../search/es-json.ts";
import { PurchaseSearchService } from "../../search/purchase-search.ts";
import { HandBackToRails } from "../application-controller.ts";

export const VALID_GROUPS = ["product", "day", "week", "month", "hour"] as const;
export type Group = (typeof VALID_GROUPS)[number];
export { MAX_HOURLY_DATE_RANGE_DAYS };

type Metrics = {
  gross_cents: number;
  net_cents: number;
  units: number;
  refunded_cents: number;
  refunded_units: number;
};
type Item = Metrics & { key: string; label: string | null };
type Aggregation = {
  gross_cents: { value: number | null };
  refunded_cents: { value: number | null };
  refunded_units: { doc_count: number };
};
type Bucket = Aggregation & { key: Record<string, string | number>; doc_count: number };
type Query = { bool: Record<string, JsonValue[]> };

const METRIC_AGGS: JsonValue = {
  gross_cents: { sum: { field: "price_cents" } },
  refunded_cents: { sum: { field: "amount_refunded_cents" } },
  refunded_units: { filter: { range: { amount_refunded_cents: { gt: 0 } } } },
};

// `.to_i` of a sum, nil for an empty one
const toI = (value: number | null | undefined) => Math.trunc(value ?? 0);

function metrics(units: number, aggregation: Aggregation): Metrics {
  const gross = toI(aggregation.gross_cents.value);
  const refunded = toI(aggregation.refunded_cents.value);
  return {
    gross_cents: gross,
    net_cents: gross - refunded,
    units,
    refunded_cents: refunded,
    refunded_units: aggregation.refunded_units.doc_count,
  };
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function salesSummary(
  seller: { id: bigint; timezone: string | null },
  { from, to, groupBy }: { from: string; to: string; groupBy: Group | null },
) {
  let iana: string;
  let query: Query;
  try {
    iana = timezoneId(seller.timezone);
    // SEARCH_OPTIONS of CreatorAnalytics::Sales: refunds and chargebacks stay in, the metrics subtract them
    const options = {
      ...CHARGED_SALES_SEARCH_OPTIONS,
      exclude_refunded: false,
      exclude_unreversed_chargedback: false,
      seller: { id: Number(seller.id) },
      size: 0,
    };
    query = new PurchaseSearchService(options).body.query as unknown as Query;
    // CreatorAnalytics::DateQuery.day_start of `from` and of the day after `to`
    (query.bool.must ??= []).push(
      { range: { created_at: { gte: dayStartIso(from, iana) } } },
      { range: { created_at: { lt: dayStartIso(addDays(to, 1), iana) } } },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "NotPortedError") throw new HandBackToRails(error.message);
    throw error;
  }

  const { body } = await search({
    index: indexName("Purchase"),
    body: { query, size: 0, track_total_hits: true, aggs: METRIC_AGGS } as unknown as JsonValue,
  });
  const response = body as { hits: { total: { value: number } }; aggregations: Aggregation };
  const result: Record<string, unknown> = {
    ...metrics(response.hits.total.value, response.aggregations),
    currency: "usd",
    from,
    to,
  };
  if (groupBy !== null) result.breakdown = await breakdown(seller.id, iana, query, groupBy);
  return result;
}

async function breakdown(sellerId: bigint, iana: string, query: Query, groupBy: Group): Promise<Item[]> {
  const histogram: Record<string, JsonValue> = { time_zone: iana, field: "created_at", calendar_interval: groupBy };
  // Hour buckets are keyed by epoch milliseconds and formatted in the seller's zone: an offset-less hour is ambiguous at a DST fall-back.
  if (groupBy !== "hour") histogram.format = groupBy === "month" ? "yyyy-MM" : "yyyy-MM-dd";
  const sources: JsonValue[] = [
    groupBy === "product"
      ? { product_id: { terms: { field: "product_id" } } }
      : { date: { date_histogram: histogram } },
  ];
  const composite: Record<string, JsonValue> = { size: ES_MAX_BUCKET_SIZE, sources };
  const request = { query, size: 0, aggs: { breakdown: { composite, aggs: METRIC_AGGS } } } as unknown as JsonValue;
  const buckets: Bucket[] = [];
  for (;;) {
    const { body } = await search({ index: indexName("Purchase"), body: request });
    const aggregation = (body as { aggregations: { breakdown: { buckets: Bucket[]; after_key?: JsonValue } } })
      .aggregations.breakdown;
    buckets.push(...aggregation.buckets);
    if (aggregation.buckets.length < ES_MAX_BUCKET_SIZE) break;
    composite.after = aggregation.after_key as JsonValue;
  }

  if (groupBy === "product") {
    const ids = [...new Set(buckets.map((bucket) => BigInt(bucket.key.product_id!)))];
    const products = new Map<string, string | null>();
    if (ids.length > 0) {
      const rows = await selectRows<{ id: bigint; name: string | null }>(
        Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "name")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "id")} IN (${Prisma.join(ids)})`,
      );
      for (const row of rows) products.set(String(row.id), row.name);
    }
    const items: Item[] = buckets.map((bucket) => {
      const id = String(bucket.key.product_id);
      const found = products.has(id);
      return {
        ...metrics(bucket.doc_count, bucket),
        key: found ? encrypt(BigInt(id)) : id,
        label: found ? (products.get(id) ?? null) : null,
      };
    });
    // sort_by is not stable: equal [gross, label] pairs could come out in either order
    const order = (a: Item, b: Item) => b.gross_cents - a.gross_cents || byteOrder(a.label ?? "", b.label ?? "");
    const sorted = items.toSorted(order);
    for (let i = 1; i < sorted.length; i++)
      if (order(sorted[i - 1]!, sorted[i]!) === 0)
        throw new HandBackToRails("product breakdown rows that tie on gross and label");
    return sorted;
  }

  const items: Item[] = buckets.map((bucket) => {
    const key = groupBy === "hour" ? hourKey(Number(bucket.key.date), iana) : String(bucket.key.date);
    return { ...metrics(bucket.doc_count, bucket), key, label: key };
  });
  // At a DST fall-back one local hour occurs twice: its two buckets become one item
  const merged = new Map<string, Item>();
  for (const item of items) {
    const first = merged.get(item.key);
    if (first === undefined) merged.set(item.key, item);
    else
      merged.set(item.key, {
        ...first,
        gross_cents: first.gross_cents + item.gross_cents,
        net_cents: first.net_cents + item.net_cents,
        units: first.units + item.units,
        refunded_cents: first.refunded_cents + item.refunded_cents,
        refunded_units: first.refunded_units + item.refunded_units,
      });
  }
  return [...merged.values()].toSorted((a, b) => byteOrder(a.key, b.key));
}
