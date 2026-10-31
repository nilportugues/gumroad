// ElasticsearchIndexerWorker#perform (app/sidekiq/elasticsearch_indexer_worker.rb).
import { Prisma } from "@prisma/client";

import { indexName, productPageViewIndexForTimestamp, type SearchModel } from "../infra/elasticsearch.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { selectRows } from "../models/sql.ts";
import { clearScroll, type DocumentId, deleteDocument, indexDocument, scroll, search, updateByQuery, updateDocument } from "./api.ts";
import { PurchaseRecord, RubyNoMethodError } from "./documents/purchase.ts";
import { AudienceMemberRecord, InstallmentRecord } from "./documents/simple.ts";
import type { JsonValue } from "./es-json.ts";
import { col, q } from "./rows.ts";
import { type EsResponse, isConflict, isTimeout } from "./transport.ts";

export const UPDATE_BY_QUERY_SCROLL_SIZE = 100;
const UPDATE_BY_QUERY_IDS_MAX_RETRIES = 10;
const HARD_DELETED_CLASSES = ["AudienceMember"];
const IGNORE_404_KEY = "elasticsearch_indexer_worker_ignore_404_errors_on_indices";
const DELAY_UBQS_FEATURE = "esiw_delay_ubqs";
const UBQ_DELAY_WINDOW_SECONDS = 72 * 3600;
const UBQ_DELAY_FLOOR_SECONDS = 6 * 3600;

const UPDATE_BY_QUERY_SCRIPT = "for (item in params.new_values) { ctx._source[item.key] = item.value; }";

export type IndexerDeps = {
  // Feature.active?(name)
  featureActive: (name: string) => Promise<boolean>;
  // $redis.smembers(key)
  smembers: (key: string) => Promise<string[]>;
  // Kernel#rand(n) for an Integer n
  rand: (max: number) => number;
  sleep: (seconds: number) => Promise<void>;
};

export class RecordNotFound extends Error {
  constructor(className: string, id: unknown) {
    super(`Couldn't find ${className} with 'id'=${String(id)}`);
    this.name = "ActiveRecord::RecordNotFound";
  }
}

class KeyError extends Error {
  constructor(key: string) {
    super(`key not found: ${JSON.stringify(key)}`);
    this.name = "KeyError";
  }
}

// A document builder for a model whose rows are indexed.
type Indexable = { asIndexedJson(only?: readonly string[]): Promise<Record<string, JsonValue>>; searchFieldValue(field: string): Promise<JsonValue> };

type ModelClass = {
  model: SearchModel;
  table?: string;
  find?: (id: unknown) => Promise<Indexable | null>;
  indexNameFromBody?: (body: JsonValue) => string;
};

// The classes `class_name` constantizes to. Link (Product::Searchable) is indexed through
// ProductIndexingService, never this worker, and its document is not ported.
const CLASSES: Record<string, ModelClass> = {
  Purchase: { model: "Purchase", table: "purchases", find: (id) => PurchaseRecord.find(id) },
  Installment: { model: "Installment", table: "installments", find: (id) => InstallmentRecord.find(id) },
  AudienceMember: { model: "AudienceMember", table: "audience_members", find: (id) => AudienceMemberRecord.find(id) },
  ConfirmedFollowerEvent: { model: "ConfirmedFollowerEvent" },
  ProductPageView: {
    model: "ProductPageView",
    indexNameFromBody: (body) => productPageViewIndexForTimestamp(String((body as Record<string, JsonValue>).timestamp)),
  },
};

function constantize(name: unknown): ModelClass {
  const klass = CLASSES[String(name)];
  if (klass) return klass;
  if (name === "Link") throw new Error("ElasticsearchIndexerWorker for Link (Product::Searchable#as_indexed_json) is not ported");
  const error = new Error(`uninitialized constant ${String(name)}`);
  error.name = "NameError";
  throw error;
}

function fetch(params: Record<string, JsonValue>, key: string): JsonValue {
  if (!Object.hasOwn(params, key)) throw new KeyError(key);
  return params[key]!;
}

// ActiveRecord casts the id to the column's integer type before quoting it.
function castId(id: JsonValue): unknown {
  if (typeof id === "string" && /^\s*-?\d+/u.test(id)) return BigInt(/^\s*(-?\d+)/u.exec(id)![1]!);
  return id;
}

async function findRecord(className: string, klass: ModelClass, id: JsonValue): Promise<Indexable> {
  if (!klass.find) throw new RubyNoMethodError("find");
  const record = await klass.find(castId(id));
  if (!record) throw new RecordNotFound(className, id);
  return record;
}

function documentId(id: JsonValue): DocumentId {
  if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") return id;
  return String(id);
}

export async function performIndexer(operation: JsonValue, params: Record<string, JsonValue>, deps: IndexerDeps): Promise<void> {
  try {
    await perform(operation, params, deps);
  } catch (error) {
    if (!(error instanceof RecordNotFound)) throw error;
    // Hard-deleted models: the destroy's own after_commit enqueued the delete, so a missing row is
    // expected; anything else (replica lag included) keeps its retries.
    if (!HARD_DELETED_CLASSES.includes(String(params.class_name))) throw error;
    const searchedId = params.record_id;
    if (searchedId === undefined || searchedId === null) throw error;
    const klass = constantize(fetch(params, "class_name"));
    const [row] = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${Prisma.raw(q(klass.table!))} WHERE ${col(klass.table!, "id")} = ${castId(searchedId)} LIMIT 1`);
    if (row) throw error;
  }
}

async function perform(operation: JsonValue, params: Record<string, JsonValue>, deps: IndexerDeps): Promise<void> {
  if (operation === "update_by_query") {
    if (await deps.featureActive(DELAY_UBQS_FEATURE)) {
      await performAsync("ElasticsearchIndexerWorker", [operation, params], { delaySeconds: deps.rand(UBQ_DELAY_WINDOW_SECONDS) + UBQ_DELAY_FLOOR_SECONDS });
      return;
    }
    await performUpdateByQuery(params, deps);
    return;
  }

  // Balance is no longer indexed; drop jobs queued before it was retired.
  if (params.class_name === "Balance") return;

  const className = String(fetch(params, "class_name"));
  const klass = constantize(className);
  let index = indexName(klass.model);
  const ignore: number[] = [];
  if ((await deps.smembers(IGNORE_404_KEY)).includes(index)) ignore.push(404);

  let recordId: JsonValue = null;
  let id: JsonValue;
  if (Object.hasOwn(params, "record_id")) {
    recordId = params.record_id!;
    id = recordId;
  } else {
    id = fetch(params, "id");
  }

  switch (operation) {
    case "index": {
      const body = params.body !== undefined && params.body !== null && params.body !== false ? params.body : await (await findRecord(className, klass, recordId)).asIndexedJson();
      if (klass.indexNameFromBody) index = klass.indexNameFromBody(body);
      await indexDocument({ index, id: documentId(id), body, ignore });
      return;
    }
    case "update": {
      const fields = fetch(params, "fields") as string[];
      const doc = await (await findRecord(className, klass, recordId)).asIndexedJson(fields);
      await updateDocument({ index, id: documentId(id), body: { doc }, ignore });
      return;
    }
    case "delete":
      if (!ignore.includes(404)) ignore.push(404);
      await deleteDocument({ index, id: documentId(id), ignore });
      return;
  }
}

function hitsOf(response: EsResponse): { _id: string }[] {
  const body = response.body as { hits?: { hits?: { _id: string }[] } } | null;
  const hits = body?.hits?.hits;
  if (hits === undefined || hits === null) throw new RubyNoMethodError("empty?");
  return hits;
}

const scrollIdOf = (response: EsResponse) => ((response.body as { _scroll_id?: string } | null)?._scroll_id ?? null) as string | null;

async function performUpdateByQuery(params: Record<string, JsonValue>, deps: IndexerDeps): Promise<void> {
  const className = String(fetch(params, "class_name"));
  const klass = constantize(className);
  const source = await findRecord(className, klass, fetch(params, "source_record_id"));
  const newValues: JsonValue[] = [];
  for (const field of fetch(params, "fields") as string[]) {
    if (field.includes(".")) throw Object.assign(new Error(`Updating nested fields ('${field}') by query is not supported`), { name: "RuntimeError" });
    newValues.push({ key: field, value: await source.searchFieldValue(field) });
  }
  const index = indexName(klass.model);
  const query = fetch(params, "query");

  // Most run without conflicts; scroll only when the direct update_by_query conflicts or times out.
  try {
    await updateByQuery({ index, body: { script: { source: UPDATE_BY_QUERY_SCRIPT, params: { new_values: newValues } }, query } });
    return;
  } catch (error) {
    if (!isConflict(error) && !isTimeout(error)) throw error;
  }

  let response = await search({ index, scroll: "1m", body: { query }, size: UPDATE_BY_QUERY_SCROLL_SIZE, sort: ["_doc"], source: false });
  for (;;) {
    const hits = hitsOf(response);
    if (hits.length === 0) break;
    const ids = hits.map((hit) => hit._id);
    await updateByQueryIds(index, newValues, ids, deps);
    if (hits.length < UPDATE_BY_QUERY_SCROLL_SIZE) break;
    response = await scroll({ scrollId: scrollIdOf(response) as string, scroll: "1m" });
  }
  await clearScroll(scrollIdOf(response));
}

async function updateByQueryIds(index: string, newValues: JsonValue[], ids: string[], deps: IndexerDeps): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await updateByQuery({ index, body: { script: { source: UPDATE_BY_QUERY_SCRIPT, params: { new_values: newValues } }, query: { terms: { _id: ids } } } });
      return;
    } catch (error) {
      if (!isConflict(error) || tries === UPDATE_BY_QUERY_IDS_MAX_RETRIES) throw error;
      await deps.sleep(1);
    }
  }
}
