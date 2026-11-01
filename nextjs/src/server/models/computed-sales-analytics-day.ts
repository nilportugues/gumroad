// Port of app/models/computed_sales_analytics_day.rb: the analytics cache large sellers read and write.
import { Prisma, type ComputedSalesAnalyticsDay } from "@prisma/client";

import { esJson, type JsonValue } from "../search/es-json.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, isRecordNotUnique, selectRows, table } from "./sql.ts";

const TABLE = "computed_sales_analytics_days";

export const ComputedSalesAnalyticsDays = defineModel<ComputedSalesAnalyticsDay>({
  rubyClass: "ComputedSalesAnalyticsDay",
  prismaModel: "ComputedSalesAnalyticsDay",
  delegate: (tx) => tx.computedSalesAnalyticsDay as never,
});

type Json = unknown;

async function findByKey(key: string): Promise<ModelRecord<ComputedSalesAnalyticsDay> | null> {
  const rows = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`\`${TABLE}\`.*`)} FROM ${table(TABLE)} WHERE ${column(TABLE, "key")} = ${key} LIMIT 1`);
  return rows[0] ? ComputedSalesAnalyticsDays.load(castRow<ComputedSalesAnalyticsDay>("ComputedSalesAnalyticsDay", rows[0])) : null;
}

// `create_or_find_by!`: insert in its own transaction; on a unique-key collision, `find_by!` the winner.
async function createOrFindByKey(key: string, data: string, now: () => Date): Promise<ModelRecord<ComputedSalesAnalyticsDay>> {
  try {
    return await transaction(() => ComputedSalesAnalyticsDays.createBang({ key, data }, { now }));
  } catch (error) {
    if (!isRecordNotUnique(error)) throw error;
    const found = await findByKey(key);
    if (!found) throw new Error("Couldn't find ComputedSalesAnalyticsDay");
    return found;
  }
}

// `where(key: keys).order(:key).pluck(:key, :data)` merged over `{ key => nil }`: keys with no row read nil.
// `data` is a JSON document; a row whose data is NULL fails in `JSON.parse(nil)`, as it would in Ruby.
export async function readDataFromKeys(keys: string[]): Promise<Map<string, Json | null>> {
  const result = new Map<string, Json | null>(keys.map((key) => [key, null]));
  if (keys.length === 0) return result;
  const rows = await selectRows<{ key: string; data: string | null }>(
    Prisma.sql`SELECT ${column(TABLE, "key")}, ${column(TABLE, "data")} FROM ${table(TABLE)} WHERE ${column(TABLE, "key")} IN (${Prisma.join(keys)}) ORDER BY ${column(TABLE, "key")} ASC`,
  );
  for (const row of rows) {
    if (row.data === null) throw new TypeError("no implicit conversion of nil into String");
    result.set(row.key, JSON.parse(row.data));
  }
  return result;
}

// `fetch_data_from_key(key) { compute }`: callers query Elasticsearch, so the block runs before the creation transaction.
export async function fetchDataFromKey(key: string, compute: () => Promise<Json>, now: () => Date = () => new Date()): Promise<Json> {
  const record = await findByKey(key);
  if (record) return JSON.parse(record.get("data") as string);
  const data = esJson((await compute()) as JsonValue);
  const created = await createOrFindByKey(key, data, now);
  return JSON.parse(created.get("data") as string);
}

// `upsert_data_from_key(key, data)`
export async function upsertDataFromKey(key: string, data: Json, now: () => Date = () => new Date()): Promise<void> {
  const serialized = esJson(data as JsonValue);
  const record = (await findByKey(key)) ?? (await createOrFindByKey(key, serialized, now));
  await ComputedSalesAnalyticsDays.updateBang(record, { data: serialized }, { now });
}

// `where(key: keys).pluck(:key)`
export async function existingKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await selectRows<{ key: string }>(Prisma.sql`SELECT ${column(TABLE, "key")} FROM ${table(TABLE)} WHERE ${column(TABLE, "key")} IN (${Prisma.join(keys)})`);
  return new Set(rows.map((row) => row.key));
}
