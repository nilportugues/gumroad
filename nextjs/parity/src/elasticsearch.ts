// Rebuilds the Elasticsearch indices a replayed page searches, from what the fixture holds: the rows the
// replayer seeds into MySQL (documents the port's own indexers build) and the documents of indices that have
// no table behind them (`Exchange.elasticsearch`). Indices get the port's own names (ES_INDEX_SUFFIX) and
// the settings and mappings Rails' test indices carry.
import { Client } from "@elastic/elasticsearch";

import { resolveTimeToken } from "./canonical";
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
  const body = documents.flatMap(({ id, body: document }) => [{ index: { _index: index, ...(id === undefined ? {} : { _id: id }) } }, document]);
  const result = await es.bulk({ body, refresh: true });
  if (result.body.errors) throw new Error(`Bulk indexing into ${index} failed: ${JSON.stringify(result.body.items.find((item: Record<string, { error?: unknown }>) => item.index?.error))}`);
}
