// Rebuilds the Elasticsearch indices a replayed page searches, from what the fixture holds: the rows the
// replayer seeds into MySQL (documents the port's own indexers build) and the documents of indices that have
// no table behind them (`Exchange.elasticsearch`). Indices get the port's own names (ES_INDEX_SUFFIX) and
// the settings and mappings Rails' test indices carry.
import { Client } from "@elastic/elasticsearch";

import { PurchaseRecord } from "@/server/search/documents/purchase";
import { esJson, type JsonValue } from "@/server/search/es-json";

import { resolveTimeToken } from "./canonical";
import type { SqlExecutor } from "./db";
import type { Exchange } from "./fixture";

export const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200";

// Rails' test indices (spec/support/elasticsearch.rb: `<model>-test`), the source of settings and mappings.
export const RAILS_TEST_INDEX = {
  ConfirmedFollowerEvent: "confirmedfollowerevent-test",
  Purchase: "purchase-test",
  Link: "link-test",
  Installment: "installment-test",
  ProductPageView: "productpageview-test",
  AudienceMember: "audiencemember-test",
} as const;

export type ReplayModel = keyof typeof RAILS_TEST_INDEX;

export const replayIndexName = (base: string, suffix: string) => `${base}${suffix}`;

export type ReplayIndex = { model: ReplayModel; name: string };

// Drops and recreates `name` as the Rails test index of `model` is defined.
export async function recreateIndex(es: Client, { model, name }: ReplayIndex): Promise<void> {
  const source = RAILS_TEST_INDEX[model];
  const definition = (await es.indices.get({ index: source })).body[source];
  await es.indices.delete({ index: name }, { ignore: [404] });
  await es.indices.create({
    index: name,
    body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0, analysis: definition.settings.index.analysis, sort: definition.settings.index.sort } }, mappings: definition.mappings },
  });
}

const resolveTokens = (value: unknown, now: Date): unknown => {
  if (typeof value === "string") return resolveTimeToken(value, now)?.toISOString() ?? value;
  if (Array.isArray(value)) return value.map((entry) => resolveTokens(entry, now));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveTokens(entry, now)]));
  return value;
};

// The documents the recorder captured for `model`, with their time tokens resolved against the replay's clock.
export function seededDocuments(exchange: Exchange, model: ReplayModel, now: Date): Record<string, unknown>[] {
  return (exchange.elasticsearch?.[model] ?? []).map(({ source }) => resolveTokens(source, now) as Record<string, unknown>);
}

export async function bulkIndex(es: Client, index: string, documents: { id?: string; body: Record<string, unknown> }[]): Promise<void> {
  if (documents.length === 0) return;
  // Documents may hold bigints and Ruby floats, which only the port's own serializer writes.
  const lines = documents.flatMap(({ id, body: document }) => [{ index: { _index: index, ...(id === undefined ? {} : { _id: id }) } }, document]);
  const result = await es.bulk({ body: `${lines.map((line) => esJson(line as JsonValue)).join("\n")}\n`, refresh: true });
  if (result.body.errors) throw new Error(`Bulk indexing into ${index} failed: ${JSON.stringify(result.body.items.find((item: Record<string, { error?: unknown }>) => item.index?.error))}`);
}

// The purchases index from the seeded rows, with the documents the port's own indexer builds (as_indexed_json).
// The vitest process reads the same database as the server (DATABASE_URL).
export async function reindexPurchases(es: Client, index: string, sql: SqlExecutor): Promise<void> {
  const rows = await sql.query("SELECT id FROM purchases ORDER BY id");
  const documents: { id: string; body: Record<string, unknown> }[] = [];
  for (const { id } of rows) {
    const record = await PurchaseRecord.find(id);
    if (record) documents.push({ id: String(id), body: await record.asIndexedJson() });
  }
  await bulkIndex(es, index, documents);
}
