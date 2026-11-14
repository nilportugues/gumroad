// Discover::AutocompletePresenter#props: the suggestions behind the Discover search box.
import { Prisma } from "@prisma/client";

import { indexName } from "../../infra/elasticsearch.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { anyThumbnailUrl } from "../../page-props/buyer/products.ts";
import { NotPortedError } from "../../page-props/not-ported.ts";
import { search } from "../../search/api.ts";
import type { JsonValue } from "../../search/es-json.ts";
import { partialSearchOptions, searchOptions, searchProducts } from "../../search/product-search.ts";
import { present } from "../../search/ruby-params.ts";
import { defaultSearchProductsDeps } from "../../search/search-products.ts";
import { findLink, findUserById } from "../product-reads.ts";
import { longUrl } from "../product.ts";

export const RECENT_SEARCH_LIMIT = 100;
export const PRODUCT_RESULT_COUNT = 5;
const RECENT_SEARCH_PREVIEW_COUNT = 5;
const FILTERED_RECENT_SEARCH_COUNT = 8;
const GUMROAD_SEARCH_RECOMMENDATION = "search";
const DISCOVER_LAYOUT = "discover";

export type AutocompleteViewer = { user: { id: bigint } | null; browserGuid: string | null };

export type AutocompleteProduct = {
  name: string;
  url: string;
  seller_name: string | null;
  thumbnail_url: string | null;
};

// `@query = query.to_s.downcase`
const normalizedQuery = (query: unknown): string =>
  query === null || query === undefined ? "" : String(query).toLowerCase();

// Ruby's String#split with no argument: runs of ASCII whitespace, no empty leading field.
const words = (value: string): string[] => value.split(/[\t\n\v\f\r ]+/u).filter((word) => word !== "");

// DiscoverSearchSuggestion.by_user_or_browser(...).order(created_at: :desc), selecting discover_searches.query.
// created_at has second precision, so rows made together tie; MySQL then returned the newest id first.
function recentSearchRows(
  viewer: AutocompleteViewer,
  distinct: boolean,
  limit: number,
): Promise<{ query: string | null }[]> {
  const owner = viewer.user
    ? Prisma.sql`${column("discover_searches", "user_id")} = ${viewer.user.id}`
    : viewer.browserGuid === null
      ? Prisma.sql`${column("discover_searches", "browser_guid")} IS NULL AND ${column("discover_searches", "user_id")} IS NULL`
      : Prisma.sql`${column("discover_searches", "browser_guid")} = ${viewer.browserGuid} AND ${column("discover_searches", "user_id")} IS NULL`;
  const suggestionCreatedAt = column("discover_search_suggestions", "created_at");
  const suggestionId = column("discover_search_suggestions", "id");
  // Rails' `.distinct` plus the scope's ORDER BY only runs because its connection drops ONLY_FULL_GROUP_BY; grouping
  // by the query keeps the newest-first order on a connection that has it.
  const ordering = distinct
    ? Prisma.sql`GROUP BY ${column("discover_searches", "query")} ORDER BY MAX(${suggestionCreatedAt}) DESC, MAX(${suggestionId}) DESC`
    : Prisma.sql`ORDER BY ${suggestionCreatedAt} DESC, ${suggestionId} DESC`;
  return selectRows<{ query: string | null }>(
    Prisma.sql`SELECT ${column("discover_searches", "query")} FROM ${table("discover_search_suggestions")} INNER JOIN ${table("discover_searches")} ON ${column("discover_searches", "id")} = ${column("discover_search_suggestions", "discover_search_id")} WHERE ${column("discover_search_suggestions", "deleted_at")} IS NULL AND ${owner} ${ordering} LIMIT ${limit}`,
  );
}

// #filter_recent_searches
function filterRecentSearches(searches: string[], query: string): string[] {
  const queryWords = words(query);
  return searches.filter((candidate) => {
    const lowered = candidate.toLowerCase();
    const searchWords = words(lowered);
    return (
      searchWords.some((word) => queryWords.includes(word)) ||
      searchWords.some((word) => word.startsWith(query)) ||
      query.startsWith(lowered)
    );
  });
}

async function recentSearches(viewer: AutocompleteViewer, query: string): Promise<string[]> {
  if (!present(query))
    return (await recentSearchRows(viewer, true, RECENT_SEARCH_PREVIEW_COUNT)).map((row) => row.query as string);
  const rows = await recentSearchRows(viewer, false, RECENT_SEARCH_LIMIT);
  // A suggestion exists only for a present query; a null here would raise in Ruby's downcase.
  if (rows.some((row) => row.query === null))
    throw new NotPortedError("Discover::AutocompletePresenter with a suggestion that has no query");
  return filterRecentSearches([...new Set(rows.map((row) => row.query as string))], query).slice(
    0,
    FILTERED_RECENT_SEARCH_COUNT,
  );
}

// `Link.search(search_options).records.map { ... }`
async function searchResults(body: JsonValue, query: string): Promise<AutocompleteProduct[]> {
  const products: AutocompleteProduct[] = [];
  for (const id of (await searchProducts(body)).ids) {
    const row = await findLink(BigInt(id));
    if (!row) continue;
    const seller = row.user_id === null ? null : await findUserById(row.user_id);
    if (!seller) throw new NotPortedError("Discover::AutocompletePresenter for a product without a seller");
    products.push({
      name: row.name as string,
      url: longUrl(row, seller, {
        recommendedBy: GUMROAD_SEARCH_RECOMMENDATION,
        layout: DISCOVER_LAYOUT,
        query,
        autocomplete: true,
      }),
      seller_name: present(seller.name) ? (seller.name as string) : null,
      thumbnail_url: await anyThumbnailUrl(row.id),
    });
  }
  return products;
}

const defaultProducts = async (query: string) =>
  searchResults(await searchOptions({ size: PRODUCT_RESULT_COUNT }, defaultSearchProductsDeps()), query);

// ProductPageView.search(...).map { _1["_source"]["product_id"] }, newest first.
async function recentlyViewedIds(viewer: AutocompleteViewer): Promise<number[]> {
  const identity: JsonValue = viewer.user
    ? { must: { term: { user_id: Number(viewer.user.id) } } }
    : { must: { term: { browser_guid: viewer.browserGuid } }, must_not: { exists: { field: "user_id" } } };
  const response = await search({
    index: indexName("ProductPageView"),
    body: { query: { bool: identity }, sort: { timestamp: "desc" }, size: PRODUCT_RESULT_COUNT },
  });
  const hits = (response.body as { hits?: { hits?: { _source: { product_id: number } }[] } }).hits?.hits ?? [];
  return hits.map((hit) => hit._source.product_id);
}

async function productResults(
  viewer: AutocompleteViewer,
  query: string,
): Promise<{ products: AutocompleteProduct[]; viewed?: boolean }> {
  if (present(query)) return { products: await searchResults(partialSearchOptions({ query }), query) };
  if (!viewer.user && !present(viewer.browserGuid)) return { products: await defaultProducts(query), viewed: false };

  const ids = await recentlyViewedIds(viewer);
  if (ids.length > 0)
    return {
      products: await searchResults(await searchOptions({ ids }, defaultSearchProductsDeps()), query),
      viewed: true,
    };
  return { products: await defaultProducts(query), viewed: false };
}

export async function autocompleteProps(
  rawQuery: unknown,
  viewer: AutocompleteViewer,
): Promise<{ recent_searches: string[]; products: AutocompleteProduct[]; viewed?: boolean }> {
  const query = normalizedQuery(rawQuery);
  const recent = await recentSearches(viewer, query);
  return { recent_searches: recent, ...(await productResults(viewer, query)) };
}
