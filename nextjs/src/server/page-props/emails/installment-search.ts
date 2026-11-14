// InstallmentSearchService for the emails list: the search body PaginatedInstallmentsPresenter builds
// and the ids and total it reads back. Kept local to the emails pages; the recorded bodies are in
// __fixtures__/installment-search.golden.json (spec/services/installment_search_service_golden_spec.rb).
import { indexName } from "../../infra/elasticsearch.ts";
import { search } from "../../search/api.ts";
import type { JsonValue } from "../../search/es-json.ts";

export type InstallmentListType = "published" | "scheduled" | "draft";

export type InstallmentSearchOptions = {
  sellerId: number | bigint;
  type: InstallmentListType;
  // Already stripped.
  q: string;
  from: number;
  size: number;
};

// build_body order: seller, exclude_workflow_installments, exclude_deleted, type, then the fulltext
// clause, then the native params (`aggs: {}` is not nil, so it is sent).
export function installmentSearchBody({ sellerId, type, q, from, size }: InstallmentSearchOptions): JsonValue {
  const filter: JsonValue[] = [{ bool: { minimum_should_match: 1, should: [{ term: { seller_id: Number(sellerId) } }] } }];
  const must: JsonValue[] = [];
  const mustNot: JsonValue[] = [{ exists: { field: "workflow_id" } }, { exists: { field: "deleted_at" } }];
  if (type === "published") {
    must.push({ exists: { field: "published_at" } });
  } else {
    mustNot.push({ exists: { field: "published_at" } });
    if (type === "scheduled") must.push({ term: { selected_flags: "ready_to_publish" } });
    else mustNot.push({ term: { selected_flags: "ready_to_publish" } });
  }
  if (q.trim() !== "") {
    must.push({ bool: { minimum_should_match: 1, should: [{ multi_match: { query: q.trim().toLowerCase(), fields: ["name", "message"] } }] } });
  }
  return {
    query: { bool: { filter, must, must_not: mustNot } },
    from,
    size,
    sort: ["_score", { created_at: "desc" }, { id: "desc" }],
    _source: false,
    aggs: {},
  };
}

type SearchResponse = { hits: { total: { value: number } | number; hits: { _id: string }[] } };

// `Installment.search(body)`: the ids in hit order and `results.total`.
export async function searchInstallments(options: InstallmentSearchOptions): Promise<{ ids: number[]; total: number }> {
  const response = await search({ index: indexName("Installment"), body: installmentSearchBody(options) });
  const { hits } = response.body as SearchResponse;
  const total = typeof hits.total === "number" ? hits.total : hits.total.value;
  return { ids: hits.hits.map((hit) => Number(hit._id)), total };
}
