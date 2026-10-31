// ProductIndexingService (app/services/product_indexing_service.rb), Link#enqueue_index_update_for,
// and the bodies of SendToElasticsearchWorker, the Refresh*ProductsRecommendationEligibilityJobs and
// ReindexRecommendableProductsWorker.
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { indexName } from "../infra/elasticsearch.ts";
import { afterCommitEverywhere, currentJobsRuntime, performAsync } from "../models/concerns/job-runtime.ts";
import { ago } from "../models/concerns/ruby-time.ts";
import { findInBatches } from "../models/sql.ts";
import type { Row } from "../models/runtime/record.ts";
import { pushBulkWith } from "../jobs/push-bulk.ts";
import { clearScroll, indexDocument, scroll, search, updateDocument } from "./api.ts";
import { type ProductDocumentDeps, ProductRecord } from "./documents/product.ts";
import { esJson, type JsonValue } from "./es-json.ts";
import { RecordNotFound } from "./indexer.ts";
import { cachedSelect, withQueryCache } from "./query-cache.ts";
import type { EsResponse } from "./transport.ts";

const SEND_TO_ELASTICSEARCH_WORKER = "SendToElasticsearchWorker";
const ASYNC_RETRY_DELAY_SECONDS = 5;
const TRAILING_DELAY_SECONDS = 5;
const FIND_EACH_BATCH_SIZE = 1000;
export const REINDEX_SCROLL_SIZE = 1000;
const REINDEX_SCROLL_SORT = ["_doc"];
const SALES_VOLUME_ATTRIBUTES = ["sales_volume", "total_fee_cents", "past_year_fee_cents"];
const DEFAULT_SALES_VOLUME_RECENTNESS = { months: 3 };
const SECONDS_PER_MINUTE = 60;

export type ProductIndexingDeps = ProductDocumentDeps;

class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

// `Link.find_by(id:)` casts the id to an integer first; a value with no leading digits is nil.
function castId(id: JsonValue | undefined): bigint | null {
  if (typeof id === "bigint") return id;
  if (typeof id === "number" && Number.isFinite(id)) return BigInt(Math.trunc(id));
  if (typeof id === "string") {
    const match = /^\s*([+-]?\d+)/u.exec(id);
    return match ? BigInt(match[1]!) : null;
  }
  return null;
}

async function findProduct(id: JsonValue | undefined, deps: ProductIndexingDeps): Promise<ProductRecord | null> {
  const cast = castId(id);
  if (cast === null) {
    await cachedSelect(Prisma.sql`SELECT \`links\`.* FROM \`links\` WHERE \`links\`.\`id\` IS NULL LIMIT 1`);
    return null;
  }
  return ProductRecord.find(cast, deps);
}

// ProductIndexingService.perform
export async function performProductIndexing(
  product: ProductRecord,
  action: JsonValue | undefined,
  attributesToUpdate: JsonValue,
  onFailure: "raise" | "async",
): Promise<void> {
  try {
    if (action === "index") {
      await indexDocument({ index: indexName("Link"), id: product.id, body: await product.asIndexedJson() });
    } else if (action === "update") {
      const attributes = attributesToUpdate as JsonValue[];
      if (attributes.length === 0) return;
      await updateDocument({ index: indexName("Link"), id: product.id, body: { doc: await product.buildSearchUpdate(attributes) } });
    }
  } catch (error) {
    if (onFailure !== "async") throw error;
    await performAsync(SEND_TO_ELASTICSEARCH_WORKER, [product.id, action ?? null, attributesToUpdate], { delaySeconds: ASYNC_RETRY_DELAY_SECONDS });
    const list = Array.isArray(attributesToUpdate) ? attributesToUpdate.join(", ") : String(attributesToUpdate);
    console.error(`Failed to ${String(action ?? "")} product ${product.id} (${list}), queued job instead`);
  }
}

// Link#enqueue_index_update_for, for several products: after commit, each is found again and
// updated, a failed update falling back to a SendToElasticsearchWorker job. One callback runs
// them in order, as Ruby's per-product callbacks run back to back at commit, under one query cache.
export function enqueueIndexUpdatesFor(productIds: readonly (bigint | number)[], changedSearchFields: string[], deps: ProductIndexingDeps): Promise<void> {
  return afterCommitEverywhere(() =>
    withQueryCache(async () => {
      for (const id of productIds) await updateFoundProduct(id, changedSearchFields, deps);
    }),
  );
}

async function updateFoundProduct(id: bigint | number, changedSearchFields: string[], deps: ProductIndexingDeps): Promise<void> {
  const product = await ProductRecord.find(id, deps);
  if (!product) throw new RecordNotFound("Link", id);
  await performProductIndexing(product, "update", changedSearchFields, "async");
}

const trailingKey = (args: JsonValue[]) => `send_to_elasticsearch_worker:trailing:${createHash("sha1").update(esJson(args)).digest("hex")}`;

// SendToElasticsearchWorker#perform
export async function sendToElasticsearch(args: JsonValue[], deps: ProductIndexingDeps): Promise<void> {
  const [linkId, action] = args;
  const attributesToUpdate = args[2] ?? [];
  const dropped = Number(await currentJobsRuntime().sidekiqRedis.del(trailingKey(args))) > 0;
  let failed = false;
  try {
    const product = await findProduct(linkId, deps);
    if (!product) return;
    await performProductIndexing(product, action, attributesToUpdate, "raise");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A duplicate dropped while this job waited may have committed after this run read the data.
    if (dropped && !failed) await performAsync(SEND_TO_ELASTICSEARCH_WORKER, args, { delaySeconds: TRAILING_DELAY_SECONDS });
  }
}

// RefreshUserProductsRecommendationEligibilityJob / RefreshMerchantAccountProductsRecommendationEligibilityJob#perform
export async function refreshProductsRecommendationEligibility(userId: JsonValue | undefined, deps: ProductIndexingDeps): Promise<void> {
  const cast = castId(userId);
  const [user] = await cachedSelect<Row>(
    cast === null
      ? Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE \`users\`.\`id\` IS NULL LIMIT 1`
      : Prisma.sql`SELECT \`users\`.* FROM \`users\` WHERE \`users\`.\`id\` = ${cast} LIMIT 1`,
  );
  if (!user) return;
  await findInBatches<Row>("links", Prisma.sql`\`links\`.\`user_id\` = ${user.id}`, FIND_EACH_BATCH_SIZE, async (products) => {
    for (const product of products) await enqueueIndexUpdatesFor([product.id as bigint], ["is_recommendable"], deps);
  });
}

function hitsOf(response: EsResponse): { _id: string }[] {
  const hits = (response.body as { hits?: { hits?: { _id: string }[] } } | null)?.hits?.hits;
  if (hits === undefined || hits === null) throw new NoMethodError("undefined method 'map' for nil");
  return hits;
}

const scrollIdOf = (response: EsResponse) => ((response.body as { _scroll_id?: string } | null)?._scroll_id ?? null) as string | null;

// String#to_i
const toI = (value: string) => {
  const match = /^\s*([+-]?\d+)/u.exec(String(value));
  return match ? Number(match[1]) : 0;
};

// ReindexRecommendableProductsWorker#perform
export async function reindexRecommendableProducts(deps: ProductIndexingDeps & { scrollSize?: number }): Promise<void> {
  const scrollSize = deps.scrollSize ?? REINDEX_SCROLL_SIZE;
  const index = indexName("Link");
  let response = await search({ index, scroll: "1m", body: { query: { term: { is_recommendable: true } } }, size: scrollSize, sort: REINDEX_SCROLL_SORT, source: false });

  for (let page = 0; ; page++) {
    const hits = hitsOf(response);
    const ids = hits.map((hit) => toI(hit._id));

    // `where(link_id: [])` is answered without a query.
    const recentSaleIds = new Set<string>();
    if (ids.length > 0) {
      const productIds = ids.length === 1 ? Prisma.sql`= ${ids[0]}` : Prisma.sql`IN (${Prisma.join(ids, ", ")})`;
      const rows = await cachedSelect<{ link_id: unknown }>(
        Prisma.sql`SELECT \`purchases\`.\`link_id\` FROM \`purchases\` WHERE \`purchases\`.\`link_id\` ${productIds} GROUP BY \`purchases\`.\`link_id\` HAVING (max(created_at) >= ${ago(DEFAULT_SALES_VOLUME_RECENTNESS, deps.now())})`,
      );
      for (const row of rows) recentSaleIds.add(String(row.link_id));
    }

    if (ids.length > 0) {
      // Reconcile is_recommendable on every document: a lost refund-time refresh can leave an
      // ineligible product indexed as recommendable until this runs.
      const args = ids.map((id) => [id, "update", recentSaleIds.has(String(id)) ? [...SALES_VOLUME_ATTRIBUTES, "is_recommendable"] : ["is_recommendable"]]);
      const at = Math.floor(deps.now().getTime() / 1000) + page * SECONDS_PER_MINUTE;
      await pushBulkWith(currentJobsRuntime(), { class: SEND_TO_ELASTICSEARCH_WORKER, args, queue: "low", at });
    }

    if (hits.length < scrollSize) break;
    response = await scroll({ scrollId: scrollIdOf(response) as string, scroll: "1m" });
  }

  await clearScroll(scrollIdOf(response));
}
