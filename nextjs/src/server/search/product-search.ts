// Product::Searchable's query builders (app/modules/product/searchable.rb), the request bodies
// Link.search sends to the products index. Each builder returns the body in the key order
// Elasticsearch::DSL::Search#to_hash writes (query, aggregations, sort, size, from, then the loose
// options) and the bool clauses in the order the Ruby block first touches them (must, must_not,
// filter, should), because the bytes are what discover-search.golden.json pins.
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import { type JsonValue, timeAsJson } from "./es-json.ts";
import {
  arrayWrap,
  castBoolean,
  hasKey,
  intJson,
  isHash,
  isNil,
  kernelArray,
  type Params,
  present,
  RubyError,
  rubyToS,
  toI,
  trSpaceToHyphen,
  truthy,
} from "./ruby-params.ts";

export const MAX_NUMBER_OF_TAGS = 9;
export const MAX_NUMBER_OF_PROFILE_TAGS = 200;
export const RECOMMENDED_PRODUCTS_PER_PAGE = 9;
export const MAX_NUMBER_OF_FILETYPES = 8;
export const MAX_NUMBER_OF_TAXONOMY_ATTRIBUTE_FILTERS = 100;
export const MAX_TAXONOMY_ATTRIBUTE_FILTER_TOKENS = 20;
export const MAX_PRICE_FILTER_CENTS = 10_000_000_000n;
export const PRICE_FILTER_MAX_LENGTH = 64;
const PRICE_FILTER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
export const MAX_PARTIAL_SEARCH_RESULTS = 5;
export const MAX_RESULT_WINDOW = 10_000;
const HOT_AND_NEW_PRODUCT_RECENTNESS_MS = 90 * 86_400_000;
export const TOP_CREATORS_SIZE = 6;
export const MAX_TOP_CREATORS_SIZE = 50;

// ProductSortKey
export const ProductSortKey = {
  FEATURED: "featured",
  BEST_SELLERS: "best_sellers",
  CURATED: "curated",
  NEWEST: "newest",
  PRICE_ASCENDING: "price_asc",
  PRICE_DESCENDING: "price_desc",
  AVAILABLE_PRICE_ASCENDING: "available_price_asc",
  AVAILABLE_PRICE_DESCENDING: "available_price_desc",
  MOST_REVIEWED: "most_reviewed",
  HIGHEST_RATED: "highest_rated",
  PAGE_LAYOUT: "page_layout",
  RECENTLY_UPDATED: "recently_updated",
  HOT_AND_NEW: "hot_and_new",
  STAFF_PICKED: "staff_picked",
  REVENUE_ASCENDING: "sales_volume_asc",
  REVENUE_DESCENDING: "sales_volume_desc",
  IS_RECOMMENDABLE_ASCENDING: "recommendable_asc",
  IS_RECOMMENDABLE_DESCENDING: "recommendable_desc",
} as const;

// A SellerProfileSection passed as `params[:section]`: only `shown_products` is read.
export class SellerProfileSectionParam {
  readonly shownProducts: unknown[];
  constructor(shownProducts: unknown[]) {
    this.shownProducts = shownProducts;
  }
}

export type SearchDeps = {
  // Time.current
  now: () => Date;
  // Taxonomy.find(id).self_and_descendants.pluck(:id); raises RecordNotFound for an unknown id.
  taxonomySelfAndDescendantIds: (taxonomyId: unknown) => Promise<number[]>;
};

type Clause = { [key: string]: JsonValue };
const asJson = (value: unknown): JsonValue => value as JsonValue;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

// Elasticsearch::DSL::Search::Queries::Bool#must / #must_not skip a clause the list already holds.
function pushUnique(list: Clause[], clause: Clause): void {
  if (!list.some((existing) => deepEqual(existing, clause))) list.push(clause);
}

// price_filter_cents: (BigDecimal(value) * 100).ceil/floor clamped to 0..MAX_PRICE_FILTER_CENTS, or nil
// for a value that is too long or not a plain decimal.
function priceFilterCents(value: unknown, rounding: "ceil" | "floor"): number | undefined {
  const text = rubyToS(value);
  if ([...text].length > PRICE_FILTER_MAX_LENGTH || !PRICE_FILTER_PATTERN.test(text)) return undefined;
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/u, "");
  const [whole = "", fraction = ""] = unsigned.split(".");
  let numerator = BigInt(`${whole}${fraction}` || "0") * 100n;
  if (negative) numerator = -numerator;
  const denominator = 10n ** BigInt(fraction.length);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n) {
    if (rounding === "floor" && numerator < 0n) quotient -= 1n;
    if (rounding === "ceil" && numerator > 0n) quotient += 1n;
  }
  const clamped = quotient < 0n ? 0n : quotient > MAX_PRICE_FILTER_CENTS ? MAX_PRICE_FILTER_CENTS : quotient;
  return Number(clamped);
}

// Integer#clamp(min, max)
function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (min > max) throw new RubyError("ArgumentError", "min argument must be less than or equal to max argument");
  return value < min ? min : value > max ? max : value;
}

function sortClauses(params: Params): Clause[] {
  const by = (field: string, options: Record<string, string>): Clause => ({ [field]: options });
  const desc = { order: "desc" };
  const clauses: Clause[] = [];
  const sort = hasKey(params, "sort") ? params.sort : undefined;
  switch (isNil(sort) ? ProductSortKey.FEATURED : sort) {
    case ProductSortKey.FEATURED:
      clauses.push(by("total_fee_cents", desc), by("sales_volume", desc));
      break;
    case ProductSortKey.BEST_SELLERS:
      clauses.push(by("past_year_fee_cents", desc));
      break;
    case ProductSortKey.CURATED:
      clauses.push(by("_score", desc), by("past_year_fee_cents", desc));
      break;
    case ProductSortKey.HOT_AND_NEW:
      clauses.push(by("sales_volume", desc));
      break;
    case ProductSortKey.NEWEST:
      clauses.push(by("created_at", desc));
      break;
    case ProductSortKey.AVAILABLE_PRICE_DESCENDING:
    case ProductSortKey.PRICE_DESCENDING:
      clauses.push(by("available_price_cents", { order: "desc", mode: "min" }));
      break;
    case ProductSortKey.AVAILABLE_PRICE_ASCENDING:
    case ProductSortKey.PRICE_ASCENDING:
      clauses.push(by("available_price_cents", { order: "asc", mode: "min" }));
      break;
    case ProductSortKey.IS_RECOMMENDABLE_DESCENDING:
      clauses.push(by("is_recommendable", desc));
      break;
    case ProductSortKey.IS_RECOMMENDABLE_ASCENDING:
      clauses.push(by("is_recommendable", { order: "asc" }));
      break;
    case ProductSortKey.REVENUE_ASCENDING:
      clauses.push(by("sales_volume", { order: "asc" }));
      break;
    case ProductSortKey.REVENUE_DESCENDING:
      clauses.push(by("sales_volume", desc));
      break;
    case ProductSortKey.MOST_REVIEWED:
      clauses.push(by("reviews_count", desc));
      break;
    case ProductSortKey.HIGHEST_RATED:
      clauses.push(by("average_rating", desc), by("reviews_count", desc));
      break;
    case ProductSortKey.RECENTLY_UPDATED:
      clauses.push(by("content_updated_at", desc));
      break;
    case ProductSortKey.STAFF_PICKED:
      clauses.push(by("staff_picked_at", desc));
      break;
    default:
      break;
  }
  return clauses;
}

function sectionOf(params: Params): SellerProfileSectionParam | undefined {
  return params.section instanceof SellerProfileSectionParam ? params.section : undefined;
}

// Link.search_options
export async function searchOptions(params: Params, deps: SearchDeps): Promise<JsonValue> {
  const isAliveOnProfile = castBoolean(params.is_alive_on_profile);
  const tagsAggregationSize = present(params.user_id) && isAliveOnProfile === true ? MAX_NUMBER_OF_PROFILE_TAGS : MAX_NUMBER_OF_TAGS;
  const minPriceCents = present(params.min_price) ? priceFilterCents(params.min_price, "ceil") : undefined;
  const maxPriceCents = present(params.max_price) ? priceFilterCents(params.max_price, "floor") : undefined;

  const size = toI(hasKey(params, "size") ? params.size : RECOMMENDED_PRODUCTS_PER_PAGE);
  const from = clamp(toI(params.from) - 1n, 0n, BigInt(MAX_RESULT_WINDOW) - size);

  const must: Clause[] = [];
  const mustNot: Clause[] = [];
  const filter: Clause[] = [];
  const section = sectionOf(params);

  if (present(params.query)) {
    pushUnique(must, {
      simple_query_string: { query: asJson(params.query), fields: ["name", "creator_name", "description", "tags"], default_operator: "and" },
    });
  }

  if (truthy(params.user_id)) {
    pushUnique(must, { terms: { user_id: arrayWrap(params.user_id).map((id) => intJson(toI(id))) } });
  } else {
    pushUnique(must, { term: { is_recommendable: true } });
    if (!truthy(params.include_rated_as_adult)) pushUnique(must, { term: { rated_as_adult: false } });
  }

  if (!isNil(params.is_alive_on_profile)) pushUnique(must, { term: { is_alive_on_profile: asJson(params.is_alive_on_profile) } });

  if (present(params.ids)) {
    pushUnique(must, { terms: { _id: asJson(params.ids) } });
  } else if (section) {
    pushUnique(must, { terms: { _id: asJson(section.shownProducts) } });
  }

  if (present(params.exclude_ids)) pushUnique(mustNot, { terms: { _id: asJson(params.exclude_ids) } });

  if (truthy(params.taxonomy_id)) {
    const taxonomyIds = truthy(params.include_taxonomy_descendants) ? await deps.taxonomySelfAndDescendantIds(params.taxonomy_id) : [params.taxonomy_id];
    pushUnique(must, { terms: { taxonomy_id: asJson(taxonomyIds) } });
  }

  if (truthy(params.tags)) {
    const tagTerms = [...new Set(arrayWrap(params.tags).flatMap((tag) => [rubyToS(tag), trSpaceToHyphen(rubyToS(tag))]))];
    pushUnique(must, { terms: { "tags.keyword": tagTerms } });
  }

  if (truthy(params.filetypes)) pushUnique(must, { terms: { "filetypes.keyword": asJson(arrayWrap(params.filetypes)) } });

  if (truthy(params.taxonomy_attribute_filters) && truthy(params.taxonomy_id)) {
    const groups = new Map<string | null, unknown[]>();
    for (const token of arrayWrap(params.taxonomy_attribute_filters)) {
      const text = rubyToS(token);
      const key = text === "" ? null : text.includes(":") ? text.slice(0, text.indexOf(":")) : text;
      groups.set(key, [...(groups.get(key) ?? []), token]);
    }
    for (const tokens of groups.values()) pushUnique(must, { terms: { taxonomy_attribute_filters: asJson(tokens) } });
  }

  if (minPriceCents !== undefined || maxPriceCents !== undefined) {
    const range: Clause = {};
    if (minPriceCents !== undefined) range.gte = minPriceCents;
    if (maxPriceCents !== undefined) range.lte = maxPriceCents;
    filter.push({ range: { available_price_cents: range } });
  }

  if (truthy(params.rating)) {
    const range: Clause = {};
    if (toI(params.rating) > 0n) range.gte = intJson(toI(params.rating));
    filter.push({ range: { average_rating: range } });
    pushUnique(must, { term: { display_product_reviews: "true" } });
  }

  if (truthy(params.min_reviews_count)) filter.push({ range: { reviews_count: { gte: intJson(toI(params.min_reviews_count)) } } });

  if (params.sort === ProductSortKey.HOT_AND_NEW) {
    filter.push({ range: { created_at: { gte: timeAsJson(new Date(deps.now().getTime() - HOT_AND_NEW_PRODUCT_RECENTNESS_MS)) } } });
  }

  if (truthy(params.staff_picked)) filter.push({ exists: { field: "staff_picked_at" } });

  if (!isNil(params.is_subscription)) pushUnique(must, { term: { is_subscription: asJson(params.is_subscription) } });
  if (!isNil(params.is_bundle)) pushUnique(must, { term: { is_bundle: asJson(params.is_bundle) } });
  if (hasKey(params, "is_call")) pushUnique(must, { term: { is_call: asJson(params.is_call ?? null) } });
  if (hasKey(params, "is_alive")) pushUnique(must, { term: { is_alive: asJson(params.is_alive ?? null) } });
  if (present(params.offer_code)) pushUnique(must, { term: { "offer_codes.code": asJson(params.offer_code) } });

  const aggregations: Clause = { "tags.keyword": { terms: { field: "tags.keyword", size: tagsAggregationSize } } };
  if (truthy(params.include_top_creators)) {
    // Integer only: a request's strings never change the size.
    const requested = params.top_creators_size;
    const topCreatorsSize =
      typeof requested === "number" && Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_TOP_CREATORS_SIZE) : TOP_CREATORS_SIZE;
    aggregations.top_creators = {
      terms: { field: "user_id", size: topCreatorsSize, order: { sales_volume_sum: "desc" } },
      aggregations: { sales_volume_sum: { sum: { field: "sales_volume" } } },
    };
  }

  const sort = sortClauses(params);
  // In the event of a tie, sort by newest. Don't sort purchases, since they're already sorted.
  if (!((truthy(params.section) || present(params.ids)) && params.sort === ProductSortKey.PAGE_LAYOUT)) sort.push({ created_at: { order: "desc" } });

  const bool: Clause = { must };
  if (mustNot.length > 0) bool.must_not = mustNot;
  if (filter.length > 0) bool.filter = filter;

  // Only a Hash is a well-formed ES clause.
  if (isHash(params.search)) must.push(asJson(params.search) as Clause);

  const boosted = (ids: unknown[]): Clause[] => ids.map((id, index) => ({ term: { _id: { value: asJson(id), boost: ids.length - index } } }));
  if ((present(params.ids) || section) && params.sort === ProductSortKey.PAGE_LAYOUT) {
    bool.should = [...((bool.should as Clause[] | undefined) ?? []), ...boosted(kernelArray(truthy(params.ids) ? params.ids : section?.shownProducts))];
  }
  if (present(params.curated_product_ids) && params.sort === ProductSortKey.CURATED) {
    if (!Array.isArray(params.curated_product_ids)) throw new RubyError("NotPortedError", "curated_product_ids that is not an Array");
    bool.should = [...((bool.should as Clause[] | undefined) ?? []), ...boosted(params.curated_product_ids)];
  }

  const body: Clause = { query: { bool }, aggregations, sort, size: intJson(size), from: intJson(from), _source: false };
  if (truthy(params.track_total_hits)) body.track_total_hits = asJson(params.track_total_hits);
  return body;
}

// Link.filetype_options
export async function filetypeOptions(params: Params, deps: SearchDeps): Promise<JsonValue> {
  const { filetypes: _filetypes, ...rest } = params;
  const options = (await searchOptions(rest, deps)) as { query: JsonValue };
  return { query: options.query, aggregations: { "filetypes.keyword": { terms: { field: "filetypes.keyword", size: MAX_NUMBER_OF_FILETYPES } } } };
}

// Link.taxonomy_attribute_options
export async function taxonomyAttributeOptions(params: Params, deps: SearchDeps): Promise<JsonValue> {
  const { taxonomy_attribute_filters: _filters, ...rest } = params;
  const options = (await searchOptions(rest, deps)) as { query: JsonValue };
  return {
    query: options.query,
    aggregations: { taxonomy_attribute_filters: { terms: { field: "taxonomy_attribute_filters", size: MAX_NUMBER_OF_TAXONOMY_ATTRIBUTE_FILTERS } } },
  };
}

// Link.partial_search_options
export function partialSearchOptions(params: Params): JsonValue {
  const must: Clause[] = [
    { simple_query_string: { query: asJson(params.query), fields: ["name", "name.ngrams"], default_operator: "and" } },
    { term: { is_recommendable: true } },
  ];
  if (!truthy(params.include_rated_as_adult)) must.push({ term: { rated_as_adult: false } });
  return {
    query: { bool: { must } },
    sort: [{ sales_volume: { order: "desc" } }, { created_at: { order: "desc" } }],
    size: MAX_PARTIAL_SEARCH_RESULTS,
  };
}

export type ProductSearchResponse = {
  total: number | null;
  ids: string[];
  aggregations: Record<string, { buckets?: Array<Record<string, unknown>> }>;
};

// Link.search(body).response, read the way elasticsearch-model's Results does: `total` is
// hits.total.value (nil when track_total_hits is false drops it), the ids are the hits' _id.
export async function searchProducts(body: JsonValue): Promise<ProductSearchResponse> {
  const response = await search({ index: indexName("Link"), body });
  const data = response.body as {
    hits?: { total?: number | { value: number }; hits?: Array<{ _id: string }> };
    aggregations?: ProductSearchResponse["aggregations"];
  };
  const total = data.hits?.total;
  return {
    total: total === undefined ? null : typeof total === "number" ? total : total.value,
    ids: (data.hits?.hits ?? []).map((hit) => hit._id),
    aggregations: data.aggregations ?? {},
  };
}
