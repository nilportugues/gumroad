// DiscoverController#index (Discover/Index): the search params, the taxonomy lookup, the product search and its
// cards, the DiscoverSearch write and the SEO meta tags. Whatever the port cannot prove is handed to Rails whole
// by the controller's filter (controllers/discover-page.ts), before anything renders: the deferred props, the
// autocomplete request, curated products, Black Friday and the affiliate cookie.
import { Prisma } from "@prisma/client";
import { timingSafeEqual } from "node:crypto";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { parseQuery, type Query } from "../../controllers/rails-query.ts";
import { isFeatureEnabled } from "../../infra/flipper.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { bit, findLink } from "../../presenters/product-reads.ts";
import { cardForWeb, type PresenterRequest } from "../../presenters/product.ts";
import { botUserAgents, type CardForSeo, canonicalUrl, categoryPage, DISCOVER_INDEX_PATH, tagPageMetaDescription, tagPageTitle, taxonomyLabel } from "../../presenters/discover/seo.ts";
import { normalizeSearchParamValues, searchProductsWithFacets, validFilterTokens } from "../../search/search-products.ts";
import { type Params, present } from "../../search/ruby-params.ts";
import { MetaTagBuilder } from "../meta-tags.ts";
import { NotPortedError } from "../not-ported.ts";
import { taxonomiesForNav, taxonomyByPath, type TaxonomyRow } from "./taxonomies.ts";

export const RECOMMENDED_PRODUCTS_COUNT = 8;
export const INITIAL_PRODUCTS_COUNT = 36;
export const BLACK_FRIDAY_CODE = "BLACKFRIDAY2025";
const NO_MATCH_OFFER_CODE = "__no_match__";
const SHOW_NSFW_PRODUCTS_FLAG = 44;
const DEFERRED_PROPS = ["recommended_products", "recommended_wishlists", "recently_viewed"];
const GUMROAD_SEARCH_RECOMMENDATION = "search";
const DISCOVER_LAYOUT = "discover";
const NON_SEARCH_PARAMS = new Set(["taxonomy", "format"]);

export type DiscoverVisitor = { id: bigint; flags: bigint | number | null; currency_type: string | null } | null;

export type DiscoverRequest = {
  path: string;
  queryString: string;
  method: string;
  headers: Headers;
  host: string;
  hostWithPort: string;
  protocol: string;
  remoteIp: string;
  cookies: Map<string, string | null>;
  guid: string | null;
};

export type PreparedSearch = {
  // `params` after format_search_params! and the action's own mutations.
  params: Params;
  taxonomy: TaxonomyRow | null;
  searchParams: Params;
};

const rubyPresent = (value: unknown): boolean => present(Array.isArray(value) ? value.length > 0 : value);

// The request's params: query string values (a flat query only) and the route's `*taxonomy` glob.
export function requestParams(path: string, queryString: string): Params {
  assertFlatQuery(queryString);
  const query: Query = parseQuery(queryString);
  const params: Params = {};
  for (const [key, value] of Object.entries(query)) params[key] = value as string;
  if (path !== DISCOVER_INDEX_PATH) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path.replace(/^\//, ""));
    } catch {
      throw new HandBackToRails();
    }
    params.taxonomy = decoded;
  }
  return params;
}

function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// DiscoverController#black_friday_feature_active?
export async function blackFridayFeatureActive(params: Params): Promise<boolean> {
  if (await isFeatureEnabled("offer_codes_search")) return true;
  return typeof params.feature_key === "string" && params.feature_key !== "" && secureCompare(params.feature_key, process.env.SECRET_FEATURE_KEY ?? "");
}

// SearchProducts#offer_codes_search_feature_active?
async function offerCodesSearchActive(params: Params): Promise<boolean> {
  if (params.offer_code !== BLACK_FRIDAY_CODE) return false;
  return blackFridayFeatureActive(params);
}

// `Taxonomy.find_by_path(params[:taxonomy].split("/"))`
async function findTaxonomy(taxonomyParam: unknown): Promise<TaxonomyRow | null> {
  if (!rubyPresent(taxonomyParam)) return null;
  const slugs = String(taxonomyParam).split("/");
  while (slugs.at(-1) === "") slugs.pop();
  // Ruby's split keeps empty segments inside the path; closure_tree reads them as slugs.
  if (slugs.length === 0 || slugs.some((slug) => slug === "")) throw new HandBackToRails();
  return taxonomyByPath(slugs);
}

export const showsNsfwProducts = (visitor: DiscoverVisitor) => (visitor ? bit(visitor.flags, SHOW_NSFW_PRODUCTS_FLAG) : null);

// Cart.fetch_by(...)&.cart_products&.alive plus User#purchased_products: curated products come from
// RecommendedProducts::DiscoverService, which the port does not run, so a visitor it would apply to goes to Rails.
export async function hasCuratedProductSources(visitor: DiscoverVisitor, guid: string | null): Promise<boolean> {
  const carts = visitor
    ? await selectRows(Prisma.sql`SELECT 1 FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${visitor.id} AND ${column("carts", "deleted_at")} IS NULL LIMIT 1`)
    : guid
      ? await selectRows(Prisma.sql`SELECT 1 FROM ${table("carts")} WHERE ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL AND ${column("carts", "deleted_at")} IS NULL LIMIT 1`)
      : [];
  if (carts.length > 0) return true;
  if (!visitor) return false;
  return (await selectRows(Prisma.sql`SELECT 1 FROM ${table("purchases")} WHERE ${column("purchases", "purchaser_id")} = ${visitor.id} LIMIT 1`)).length > 0;
}

// DiscoverController#index up to the search: format_search_params!, the `from` skip past the recommendations
// strip, the taxonomy and the search params.
export async function prepareSearch(request: Pick<DiscoverRequest, "path" | "queryString">, visitor: DiscoverVisitor): Promise<PreparedSearch> {
  const params = await normalizeSearchParamValues(requestParams(request.path, request.queryString), { validFilterTokens });
  if (rubyPresent(params.offer_code) && !(await offerCodesSearchActive(params))) params.offer_code = NO_MATCH_OFFER_CODE;

  const taxonomy = await findTaxonomy(params.taxonomy);
  // Curated products are empty here (see hasCuratedProductSources), so the recommendations strip is not curated.
  if (Object.keys(params).every((key) => NON_SEARCH_PARAMS.has(key))) params.from = RECOMMENDED_PRODUCTS_COUNT + 1;

  const searchParams: Params = { ...params };
  if (taxonomy) {
    searchParams.taxonomy_id = taxonomy.id;
    searchParams.include_taxonomy_descendants = true;
  }
  searchParams.include_rated_as_adult = showsNsfwProducts(visitor);
  searchParams.size = INITIAL_PRODUCTS_COUNT;
  return { params, taxonomy, searchParams };
}

export function presenterRequest(request: DiscoverRequest): PresenterRequest {
  const params: Record<string, string> = {};
  return { host: request.host, hostWithPort: request.hostWithPort, protocol: request.protocol, remoteIp: request.remoteIp, params, cookies: request.cookies };
}

export type SearchResults = {
  total: number | null;
  tags_data: unknown[];
  filetypes_data: unknown[];
  taxonomy_attributes_data: unknown[];
  products: Record<string, unknown>[];
};

// The search and its cards. A card the port cannot build is a NotPortedError.
export async function searchResults(prepared: PreparedSearch, request: DiscoverRequest): Promise<SearchResults> {
  const result = await searchProductsWithFacets(prepared.searchParams);
  const products: Record<string, unknown>[] = [];
  for (const id of result.product_ids) {
    // Link.search(...).records drops ids with no row.
    if (!(await findLink(BigInt(id)))) continue;
    products.push(
      await cardForWeb(BigInt(id), {
        request: presenterRequest(request),
        recommendedBy: GUMROAD_SEARCH_RECOMMENDATION,
        target: DISCOVER_LAYOUT,
        computeDescription: false,
        query: stringParam(prepared.params.query),
        offerCode: stringParam(prepared.params.offer_code),
      }),
    );
  }
  return { total: result.total, tags_data: result.tags_data, filetypes_data: result.filetypes_data, taxonomy_attributes_data: result.taxonomy_attributes_data, products };
}

const stringParam = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// DiscoverController#is_searching?
export function isSearching(params: Params): boolean {
  if (["query", "tags", "category", "offer_code", "taxonomy_attribute_filters"].some((key) => rubyPresent(params[key]))) return true;
  return rubyPresent(params.taxonomy) && ["sort", "min_price", "max_price", "rating", "filetypes"].some((key) => rubyPresent(params[key]));
}

// Rails::Application BOT check: ApplicationController#is_bot?
export function isBot(userAgent: string | null, params: Params): boolean {
  if (userAgent === null) return false;
  const lowered = userAgent.toLowerCase();
  return botUserAgents.has(userAgent) || ["msnbot", "yahoo! slurp", "googlebot", "whatsapp"].some((bot) => lowered.includes(bot)) || rubyPresent(params.user_agent_bot);
}

const mysqlTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "000");

// CreateDiscoverSearch#create_discover_search!
export async function createDiscoverSearch(
  extras: { query: string | null; taxonomyId: bigint | null },
  request: DiscoverRequest,
  visitor: DiscoverVisitor,
  params: Params,
  now: Date = new Date(),
): Promise<void> {
  if (isBot(request.headers.get("user-agent"), params)) return;
  if (!(await isFeatureEnabled("store_discover_searches", { flipperId: request.guid ?? "" }))) return;

  const { db } = await import("../../../lib/db.ts");
  const stamp = mysqlTime(now);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO ${table("discover_searches")} (${Prisma.raw("`query`, `taxonomy_id`, `user_id`, `ip_address`, `browser_guid`, `autocomplete`, `created_at`, `updated_at`")}) VALUES (${extras.query}, ${extras.taxonomyId}, ${visitor?.id ?? null}, ${request.remoteIp}, ${request.guid}, ${false}, ${stamp}, ${stamp})`,
    );
    if (extras.query !== null && extras.query.trim() !== "") {
      const inserted = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO ${table("discover_search_suggestions")} (${Prisma.raw("`discover_search_id`, `created_at`, `updated_at`")}) VALUES (${inserted[0]!.id}, ${stamp}, ${stamp})`);
    }
  });
}

// DiscoverController#prepare_discover_page and #prepare_category_seo
export function setMetaTags(meta: MetaTagBuilder, prepared: PreparedSearch, results: SearchResults, signedIn: boolean, queryString: string): void {
  const { params } = prepared;
  if (!signedIn) meta.set({ tag_name: "base", target: "_parent" });

  const titleParts: string[] = [];
  const tags = Array.isArray(params.tags) ? (params.tags as string[]) : null;
  if (rubyPresent(params.query)) {
    titleParts.push(`Search results for "${String(params.query)}"`);
  } else if (rubyPresent(params.tags) && !rubyPresent(params.taxonomy)) {
    titleParts.push(tagPageTitle(tags ?? []));
  } else if (rubyPresent(params.tags)) {
    titleParts.push((tags ?? String(params.tags).split(",")).map((tag) => tag.trim().replace(/[-\s]+/g, " ")).join(", "));
  }
  if (rubyPresent(params.taxonomy)) titleParts.push(String(params.taxonomy).split("/").map(taxonomyLabel).join(" » "));
  const title = titleParts.length === 0 ? "Discover digital products from independent creators | Gumroad" : [...titleParts, "Gumroad"].join(" | ");
  meta.set({ title });
  meta.set({ property: "og:title", content: title });
  meta.set({ property: "og:type", content: "website" });
  meta.set({ property: "og:site_name", content: "Gumroad" });
  meta.set({ tag_name: "link", rel: "canonical", href: canonicalUrl(params), head_key: "canonical" });

  if (!rubyPresent(params.query) && rubyPresent(params.tags)) {
    const description = tagPageMetaDescription(tags ?? [], results.total ?? 0);
    meta.set({ name: "description", content: description });
    meta.set({ property: "og:description", content: description });
  } else {
    const description = "Browse over 1.6 million free and premium digital products in education, tech, design, and more categories from Gumroad creators and online entrepreneurs.";
    meta.set({ name: "description", content: description });
    meta.set({ property: "og:description", content: description });
  }

  // prepare_category_seo: a category page is a taxonomy path with at most a `from` offset.
  const taxonomyPath = rubyPresent(params.taxonomy) ? String(params.taxonomy) : null;
  if (!prepared.taxonomy || taxonomyPath === null) return;
  const rawQuery = parseQuery(queryString);
  delete rawQuery.from;
  if (Object.keys(rawQuery).length > 0) return;
  const cards = results.products;
  const title2 = categoryPage.title(taxonomyPath);
  const description = categoryPage.metaDescription(taxonomyPath, results.total ?? 0);
  meta.set({ title: title2 });
  meta.set({ property: "og:title", content: title2 });
  meta.set({ name: "description", content: description });
  meta.set({ property: "og:description", content: description });
  meta.set({ tag_name: "script", type: "application/ld+json", inner_content: categoryPage.breadcrumbListJsonLd(taxonomyPath), head_key: "breadcrumb-list-json-ld" });
  const itemList = categoryPage.itemListJsonLd(taxonomyPath, results.total, cards as CardForSeo[]);
  if (itemList) meta.set({ tag_name: "script", type: "application/ld+json", inner_content: itemList, head_key: "item-list-json-ld" });
}

// Deferred prop names a partial reload may ask for, and the request that asks only for them.
export function isDeferredOnlyRequest(headers: Headers): boolean {
  if (headers.get("x-inertia-partial-component") !== "Discover/Index") return false;
  const requested = (headers.get("x-inertia-partial-data") ?? "").split(",");
  return requested.some((name) => name !== "") && requested.every((name) => name === "" || DEFERRED_PROPS.includes(name));
}

export const isAutocompleteOnlyRequest = (headers: Headers) => headers.get("x-inertia-partial-data") === "autocomplete_results";

export async function discoverProps(prepared: PreparedSearch, results: SearchResults, visitor: DiscoverVisitor): Promise<Record<string, unknown>> {
  const { params } = prepared;
  const { defer } = await import("../lazy-props.ts");
  const deferred = (name: string) =>
    defer(() => {
      throw new NotPortedError(`Discover ${name}`);
    });
  return {
    search_results: results,
    currency_code: visitor?.currency_type ?? "usd",
    taxonomies_for_nav: await taxonomiesForNav(),
    curated_product_ids: [],
    search_offset: params.from ?? 0,
    show_black_friday_hero: false,
    is_black_friday_page: params.offer_code === BLACK_FRIDAY_CODE,
    black_friday_offer_code: BLACK_FRIDAY_CODE,
    black_friday_stats: null,
    recommended_products: deferred("recommended_products"),
    recommended_wishlists: deferred("recommended_wishlists"),
    recently_viewed: deferred("recently_viewed"),
  };
}
