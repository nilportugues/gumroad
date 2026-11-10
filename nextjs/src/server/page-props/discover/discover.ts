// DiscoverController#index (Discover/Index): the search params, the taxonomy lookup, the product search and its
// cards, the DiscoverSearch write and the SEO meta tags. Whatever the port cannot prove is handed to Rails whole
// by the controller's filter (controllers/discover-page.ts), before anything renders: the deferred props the port
// cannot answer, an autocomplete request it cannot answer, curated products, Black Friday and the affiliate cookie.
import { timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { assertFlatQuery } from "../../controllers/rails-params.ts";
import { parseQuery, type Query } from "../../controllers/rails-query.ts";
import { isFeatureEnabled, parseGateValues, readFeatureDoc, userActor } from "../../infra/flipper.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { autocompleteProps } from "../../presenters/discover/autocomplete.ts";
import { anonymousKey, recentlyViewedProps } from "../../presenters/discover/recently-viewed.ts";
import {
  botUserAgents,
  type CardForSeo,
  canonicalUrl,
  categoryPage,
  DISCOVER_INDEX_PATH,
  tagPageMetaDescription,
  tagPageTitle,
  taxonomyLabel,
} from "../../presenters/discover/seo.ts";
import { bit, findLink } from "../../presenters/product-reads.ts";
import { cardForWeb, type PresenterRequest } from "../../presenters/product.ts";
import { type Params, present } from "../../search/ruby-params.ts";
import {
  normalizeSearchParamValues,
  searchProductsWithFacets,
  validFilterTokens,
} from "../../search/search-products.ts";
import { defer } from "../lazy-props.ts";
import { MetaTagBuilder } from "../meta-tags.ts";
import { NotPortedError } from "../not-ported.ts";

import { recommendedWishlistsProps } from "./recommended-wishlists.ts";
import { taxonomiesForNav, taxonomyByPath, type TaxonomyRow } from "./taxonomies.ts";

export const RECOMMENDED_PRODUCTS_COUNT = 8;
export const INITIAL_PRODUCTS_COUNT = 36;
export const BLACK_FRIDAY_CODE = "BLACKFRIDAY2025";
const NO_MATCH_OFFER_CODE = "__no_match__";
const SHOW_NSFW_PRODUCTS_FLAG = 44;
const DEFERRED_PROPS = ["recommended_products", "recommended_wishlists", "recently_viewed"];
const GUMROAD_SEARCH_RECOMMENDATION = "search";
const GUMROAD_DISCOVER_RECOMMENDATION = "discover";
const FEATURED_DESCRIPTION_MAX_LENGTH = 300;
const DISCOVER_LAYOUT = "discover";
const RECENTLY_VIEWED_FEATURE = "discover_recently_viewed";
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
  // Rails' current_seller (the pundit user's seller), not necessarily the signed-in user.
  currentSellerId: bigint | null;
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
  return (
    typeof params.feature_key === "string" &&
    params.feature_key !== "" &&
    secureCompare(params.feature_key, process.env.SECRET_FEATURE_KEY ?? "")
  );
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

export const showsNsfwProducts = (visitor: DiscoverVisitor) =>
  visitor ? bit(visitor.flags, SHOW_NSFW_PRODUCTS_FLAG) : null;

// Curated products come from RecommendedProducts::DiscoverService, which the port does not run. It seeds on the
// visitor's `Cart.fetch_by(...)` alive cart_products plus `User#purchased_products`; with neither seed
// SalesRelatedProductsInfo.related_products returns Link.none and the list is empty, which the port answers itself.
// `fetch_by` is `user.carts.alive.first` (lowest id) or the guest cart for the guid, so only that one cart seeds.
export async function hasCuratedProductSources(visitor: DiscoverVisitor, guid: string | null): Promise<boolean> {
  const cartId = visitor
    ? (
        await selectRows<{ id: bigint }>(
          Prisma.sql`SELECT ${column("carts", "id")} FROM ${table("carts")} WHERE ${column("carts", "user_id")} = ${visitor.id} AND ${column("carts", "deleted_at")} IS NULL ORDER BY ${column("carts", "id")} ASC LIMIT 1`,
        )
      )[0]?.id
    : guid
      ? (
          await selectRows<{ id: bigint }>(
            Prisma.sql`SELECT ${column("carts", "id")} FROM ${table("carts")} WHERE ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL AND ${column("carts", "deleted_at")} IS NULL LIMIT 1`,
          )
        )[0]?.id
      : undefined;
  if (
    cartId !== undefined &&
    (
      await selectRows(
        Prisma.sql`SELECT 1 FROM ${table("cart_products")} WHERE ${column("cart_products", "cart_id")} = ${cartId} AND ${column("cart_products", "deleted_at")} IS NULL LIMIT 1`,
      )
    ).length > 0
  )
    return true;
  if (!visitor) return false;
  // purchased_products joins links, so a purchase whose product row is gone seeds nothing.
  return (
    (
      await selectRows(
        Prisma.sql`SELECT 1 FROM ${table("purchases")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("purchases", "link_id")} WHERE ${column("purchases", "purchaser_id")} = ${visitor.id} LIMIT 1`,
      )
    ).length > 0
  );
}

// DiscoverController#index up to the search: format_search_params!, the `from` skip past the recommendations
// strip, the taxonomy and the search params.
export async function prepareSearch(
  request: Pick<DiscoverRequest, "path" | "queryString">,
  visitor: DiscoverVisitor,
): Promise<PreparedSearch> {
  const params = await normalizeSearchParamValues(requestParams(request.path, request.queryString), {
    validFilterTokens,
  });
  if (rubyPresent(params.offer_code) && !(await offerCodesSearchActive(params)))
    params.offer_code = NO_MATCH_OFFER_CODE;

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
  return {
    host: request.host,
    hostWithPort: request.hostWithPort,
    protocol: request.protocol,
    remoteIp: request.remoteIp,
    params,
    cookies: request.cookies,
  };
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
  return {
    total: result.total,
    tags_data: result.tags_data,
    filetypes_data: result.filetypes_data,
    taxonomy_attributes_data: result.taxonomy_attributes_data,
    products,
  };
}

const stringParam = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// DiscoverController#is_searching?
export function isSearching(params: Params): boolean {
  if (["query", "tags", "category", "offer_code", "taxonomy_attribute_filters"].some((key) => rubyPresent(params[key])))
    return true;
  return (
    rubyPresent(params.taxonomy) &&
    ["sort", "min_price", "max_price", "rating", "filetypes"].some((key) => rubyPresent(params[key]))
  );
}

// Rails::Application BOT check: ApplicationController#is_bot?
export function isBot(userAgent: string | null, params: Params): boolean {
  if (userAgent === null) return false;
  const lowered = userAgent.toLowerCase();
  return (
    botUserAgents.has(userAgent) ||
    ["msnbot", "yahoo! slurp", "googlebot", "whatsapp"].some((bot) => lowered.includes(bot)) ||
    rubyPresent(params.user_agent_bot)
  );
}

const mysqlTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "000");

// CreateDiscoverSearch#create_discover_search!
export async function createDiscoverSearch(
  extras: { query: string | null; taxonomyId: bigint | null; autocomplete?: boolean },
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
      Prisma.sql`INSERT INTO ${table("discover_searches")} (${Prisma.raw("`query`, `taxonomy_id`, `user_id`, `ip_address`, `browser_guid`, `autocomplete`, `created_at`, `updated_at`")}) VALUES (${extras.query}, ${extras.taxonomyId}, ${visitor?.id ?? null}, ${request.remoteIp}, ${request.guid}, ${extras.autocomplete === true}, ${stamp}, ${stamp})`,
    );
    if (extras.autocomplete !== true && extras.query !== null && extras.query.trim() !== "") {
      const inserted = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ${table("discover_search_suggestions")} (${Prisma.raw("`discover_search_id`, `created_at`, `updated_at`")}) VALUES (${inserted[0]!.id}, ${stamp}, ${stamp})`,
      );
    }
  });
}

// DiscoverController#prepare_discover_page and #prepare_category_seo
export function setMetaTags(
  meta: MetaTagBuilder,
  prepared: PreparedSearch,
  results: SearchResults,
  signedIn: boolean,
  queryString: string,
): void {
  const { params } = prepared;
  if (!signedIn) meta.set({ tag_name: "base", target: "_parent" });

  const titleParts: string[] = [];
  const tags = Array.isArray(params.tags) ? (params.tags as string[]) : null;
  if (rubyPresent(params.query)) {
    titleParts.push(`Search results for "${String(params.query)}"`);
  } else if (rubyPresent(params.tags) && !rubyPresent(params.taxonomy)) {
    titleParts.push(tagPageTitle(tags ?? []));
  } else if (rubyPresent(params.tags)) {
    titleParts.push(
      (tags ?? String(params.tags).split(",")).map((tag) => tag.trim().replace(/[-\s]+/g, " ")).join(", "),
    );
  }
  if (rubyPresent(params.taxonomy)) titleParts.push(String(params.taxonomy).split("/").map(taxonomyLabel).join(" » "));
  const title =
    titleParts.length === 0
      ? "Discover digital products from independent creators | Gumroad"
      : [...titleParts, "Gumroad"].join(" | ");
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
    const description =
      "Browse over 1.6 million free and premium digital products in education, tech, design, and more categories from Gumroad creators and online entrepreneurs.";
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
  meta.set({
    tag_name: "script",
    type: "application/ld+json",
    inner_content: categoryPage.breadcrumbListJsonLd(taxonomyPath),
    head_key: "breadcrumb-list-json-ld",
  });
  const itemList = categoryPage.itemListJsonLd(taxonomyPath, results.total, cards as CardForSeo[]);
  if (itemList)
    meta.set({
      tag_name: "script",
      type: "application/ld+json",
      inner_content: itemList,
      head_key: "item-list-json-ld",
    });
}

// Deferred prop names a partial reload may ask for, and the request that asks only for them.
export function isDeferredOnlyRequest(headers: Headers): boolean {
  if (headers.get("x-inertia-partial-component") !== "Discover/Index") return false;
  const requested = (headers.get("x-inertia-partial-data") ?? "").split(",");
  return (
    requested.some((name) => name !== "") && requested.every((name) => name === "" || DEFERRED_PROPS.includes(name))
  );
}

// DiscoverController#autocomplete_results_data
export const autocompleteResults = (params: Params, visitor: DiscoverVisitor, guid: string | null) =>
  autocompleteProps(params.query, { user: visitor ? { id: visitor.id } : null, browserGuid: guid });

export const isAutocompleteOnlyRequest = (headers: Headers) =>
  headers.get("x-inertia-partial-data") === "autocomplete_results";

// What a deferred-only request asks for, when the port can answer all of it: the other props are Rails'.
// recommended_wishlists is answered for any visitor that reached here (curated sources are handed back earlier);
// recently_viewed is answered at any ramp stage.
export async function deferredPropsPortable(
  requested: string[],
  prepared: PreparedSearch,
  visitor: DiscoverVisitor,
  guid: string | null,
  request: DiscoverRequest,
): Promise<boolean> {
  for (const name of requested) {
    if (name === "recommended_products") {
      // The root page's strip is a random sample of a cached list (`discover_all_top_products`).
      if (!rubyPresent(prepared.params.offer_code) && !prepared.taxonomy) return false;
    } else if (name === "recently_viewed") {
      // A dry run: the exposure line is written once, when the prop resolves.
      if (await notPorted(() => recentlyViewedData(prepared, visitor, request, { logExposure: false }))) return false;
    } else if (name === "recommended_wishlists") {
      if (await notPorted(() => recommendedWishlistsProps(prepared.taxonomy?.id ?? null, request.currentSellerId)))
        return false;
    } else {
      return false;
    }
  }
  return true;
}

// Whether a prop the port builds hits something it cannot reproduce.
async function notPorted(build: () => Promise<unknown>): Promise<boolean> {
  try {
    await build();
    return false;
  } catch (error) {
    if (error instanceof NotPortedError) return true;
    throw error;
  }
}

export const requestedDeferredProps = (headers: Headers): string[] =>
  (headers.get("x-inertia-partial-data") ?? "").split(",").filter((name) => name !== "");

// Anonymous visitors are Flipper::Actor.new("browser_guid:#{guid}"); the percentage-of-actors gate is the ramp.
async function recentlyViewedState(visitor: DiscoverVisitor, guid: string | null) {
  const actor = visitor ? userActor(visitor.id) : { flipperId: `browser_guid:${guid}` };
  const rampPercentage = parseGateValues(await readFeatureDoc(RECENTLY_VIEWED_FEATURE)).percentageOfActors;
  return {
    treatment: await isFeatureEnabled(RECENTLY_VIEWED_FEATURE, actor),
    midRamp: rampPercentage > 0 && rampPercentage < 100,
  };
}

const hasRecentlyViewedIdentity = (prepared: PreparedSearch, visitor: DiscoverVisitor, guid: string | null): boolean =>
  !rubyPresent(prepared.params.offer_code) && (visitor !== null || rubyPresent(guid));

// DiscoverController#log_recently_viewed_exposure, one JSON line per mid-ramp request.
export function exposureLogLine(options: {
  treatment: boolean;
  hasHistory: boolean;
  userId: bigint | null;
  guid: string | null;
}): string {
  return JSON.stringify({
    event: "discover_recently_viewed_exposure",
    arm: options.treatment ? "treatment" : "control",
    has_history: options.hasHistory,
    user_id: options.userId === null ? null : Number(options.userId),
    browser_guid_hash: options.userId === null ? anonymousKey(options.guid ?? "") : null,
  });
}

// DiscoverController#recently_viewed_data. Mid-ramp both arms run the view lookup so the exposure line has a fair denominator.
async function recentlyViewedData(
  prepared: PreparedSearch,
  visitor: DiscoverVisitor,
  request: DiscoverRequest,
  { logExposure = true } = {},
) {
  if (!hasRecentlyViewedIdentity(prepared, visitor, request.guid)) return null;
  const { treatment, midRamp } = await recentlyViewedState(visitor, request.guid);
  if (!treatment && !midRamp) return null;
  const props = await recentlyViewedProps({
    user: visitor,
    browserGuid: request.guid,
    request: presenterRequest(request),
    includeRatedAsAdult: showsNsfwProducts(visitor) === true,
  });
  if (midRamp && logExposure)
    // eslint-disable-next-line no-console -- exposure lines are read from stdout
    console.info(
      exposureLogLine({ treatment, hasHistory: props !== null, userId: visitor?.id ?? null, guid: request.guid }),
    );
  return treatment ? props : null;
}

// DiscoverController#recommendations for what deferredPropsPortable lets through.
async function recommendedProducts(
  prepared: PreparedSearch,
  request: DiscoverRequest,
): Promise<Record<string, unknown>[]> {
  // Don't show any recommended/featured products when offer codes are present
  if (rubyPresent(prepared.params.offer_code)) return [];
  if (!prepared.taxonomy) throw new NotPortedError("Discover recommended_products");

  const result = await searchProductsWithFacets({
    size: RECOMMENDED_PRODUCTS_COUNT,
    taxonomy_id: prepared.taxonomy.id,
    include_taxonomy_descendants: true,
  });
  const cards: Record<string, unknown>[] = [];
  for (const id of result.product_ids) {
    if (!(await findLink(BigInt(id)))) continue;
    cards.push(
      await cardForWeb(BigInt(id), {
        request: presenterRequest(request),
        recommendedBy: GUMROAD_DISCOVER_RECOMMENDATION,
        target: DISCOVER_LAYOUT,
        descriptionMaxLength: FEATURED_DESCRIPTION_MAX_LENGTH,
      }),
    );
  }
  return cards;
}

// The deferred props alone: a deferred-only request skips the search, the cards, the DiscoverSearch write and the meta
// tags (`inertia_meta.clear`), so Inertia's merge keeps the full load's canonical and JSON-LD.
export function deferredProps(
  prepared: PreparedSearch,
  request: DiscoverRequest,
  visitor: DiscoverVisitor,
): Record<string, unknown> {
  return {
    recommended_products: defer(() => recommendedProducts(prepared, request)),
    recommended_wishlists: defer(() =>
      recommendedWishlistsProps(prepared.taxonomy?.id ?? null, request.currentSellerId),
    ),
    recently_viewed: defer(() => recentlyViewedData(prepared, visitor, request)),
  };
}

export async function discoverProps(
  prepared: PreparedSearch,
  results: SearchResults,
  visitor: DiscoverVisitor,
  request: DiscoverRequest,
): Promise<Record<string, unknown>> {
  const { params } = prepared;
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
    ...deferredProps(prepared, request, visitor),
  };
}
