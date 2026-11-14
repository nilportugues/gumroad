// Discover::RecentlyViewedPresenter#props: the "recently viewed" row, from the visitor's product page views.
import { createHash } from "node:crypto";

import { indexName } from "../../infra/elasticsearch.ts";
import { search } from "../../search/api.ts";
import type { JsonValue } from "../../search/es-json.ts";
import { searchOptions, searchProducts } from "../../search/product-search.ts";
import { present } from "../../search/ruby-params.ts";
import { defaultSearchProductsDeps } from "../../search/search-products.ts";
import { findLink } from "../product-reads.ts";
import { cardForWeb, type PresenterRequest } from "../product.ts";

export const RECENTLY_VIEWED_PRODUCT_COUNT = 8;
const VIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ANONYMOUS_KEY_LENGTH = 16;
const GUMROAD_RECENTLY_VIEWED_RECOMMENDATION = "recently_viewed";
const DISCOVER_LAYOUT = "discover";

export type RecentlyViewedProps = { products: Record<string, unknown>[]; anonymous_key: string | null };
type View = { product_id: number; timestamp: string };

// Discover::RecentlyViewedPresenter.anonymous_key
export const anonymousKey = (browserGuid: string): string => createHash("sha256").update(browserGuid).digest("hex").slice(0, ANONYMOUS_KEY_LENGTH);

// `VIEW_WINDOW.ago.iso8601` in the app's UTC zone
const iso8601 = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

async function recentViews(user: { id: bigint } | null, browserGuid: string | null, now: Date): Promise<View[]> {
  const timestampFilter: JsonValue = { range: { timestamp: { gte: iso8601(new Date(now.getTime() - VIEW_WINDOW_MS)) } } };
  const identity: JsonValue = user
    ? { must: [{ term: { user_id: Number(user.id) } }, timestampFilter] }
    : { must: [{ term: { browser_guid: browserGuid } }, timestampFilter], must_not: { exists: { field: "user_id" } } };
  const response = await search({
    index: indexName("ProductPageView"),
    body: { query: { bool: identity }, collapse: { field: "product_id" }, sort: { timestamp: "desc" }, size: RECENTLY_VIEWED_PRODUCT_COUNT },
  });
  const hits = (response.body as { hits?: { hits?: Array<{ _source: View }> } }).hits?.hits ?? [];
  return hits.map((hit) => hit._source);
}

export async function recentlyViewedProps(
  options: { user: { id: bigint } | null; browserGuid: string | null; request: PresenterRequest; includeRatedAsAdult?: boolean },
  now: Date = new Date(),
): Promise<RecentlyViewedProps | null> {
  const { user, browserGuid, request, includeRatedAsAdult = false } = options;
  if (!user && !present(browserGuid)) return null;

  const views = await recentViews(user, browserGuid, now);
  if (views.length === 0) return null;

  // First view per product wins because views are sorted desc, i.e. the most recent one.
  const viewedAt = new Map<number, string>();
  for (const view of views) if (!viewedAt.has(view.product_id)) viewedAt.set(view.product_id, view.timestamp);
  const productIds = [...viewedAt.keys()].slice(0, RECENTLY_VIEWED_PRODUCT_COUNT);

  const found = await searchProducts(await searchOptions({ ids: productIds, size: RECENTLY_VIEWED_PRODUCT_COUNT, include_rated_as_adult: includeRatedAsAdult }, defaultSearchProductsDeps()));
  const foundIds = new Set(found.ids.map(String));
  const cards: Record<string, unknown>[] = [];
  for (const id of productIds) {
    if (!foundIds.has(String(id)) || !(await findLink(BigInt(id)))) continue;
    const card = await cardForWeb(BigInt(id), { request, recommendedBy: GUMROAD_RECENTLY_VIEWED_RECOMMENDATION, target: DISCOVER_LAYOUT, computeDescription: false });
    cards.push({ ...card, viewed_at: viewedAt.get(id) });
  }
  if (cards.length === 0) return null;

  return { products: cards, anonymous_key: user ? null : anonymousKey(browserGuid!) };
}
