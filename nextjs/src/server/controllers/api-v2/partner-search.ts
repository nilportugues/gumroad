// Api::V2::Partner::ProductsController#index and CreatorsController#top: the partner's product feed and creator ranking, both
// answered by the products index. Ordering and totals are Elasticsearch's own, from the same query body Rails builds.
import { Prisma } from "@prisma/client";

import { LinkFlags } from "../../models/link.ts";
import { column, columnIn, columnNotIn, selectRows, table } from "../../models/sql.ts";
import { nameOrUsername, username, Users, UserFlags } from "../../models/user.ts";
import { isAdult } from "../../models/concerns/adult-keyword-detector.ts";
import { formattedPrice } from "../../models/concerns/money-formatter.ts";
import { RECURRENCE_LONG_INDICATOR } from "../../models/purchase-json.ts";
import { avatarUrl, profileUrl } from "../../page-props/buyer/users.ts";
import { cardForWeb, longUrl } from "../../presenters/product.ts";
import { remainingForSaleCount } from "../../presenters/product-props.ts";
import { findLink, findUserById, type LinkRow, type UserRow } from "../../presenters/product-reads.ts";
import { MAX_RESULT_WINDOW, searchOptions, searchProducts } from "../../search/product-search.ts";
import { type Params, intJson, isNil, toI } from "../../search/ruby-params.ts";
import { defaultSearchProductsDeps, normalizeSearchParamValues, validFilterTokens } from "../../search/search-products.ts";
import { HandBackToRails } from "../application-controller.ts";

import { type ApiV2Input, json, present, registerApiV2 } from "./base.ts";
import { categoriesById, type ApiCategory } from "./categories.ts";
import { partnerGuards, PARTNER_SCOPE } from "./partner-categories.ts";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const BEST_SELLERS = "best_sellers";
// BasePrice::Recurrence::RECURRENCE_TO_NUMBER_OF_MONTHS
const MONTHS_IN_RECURRENCE: Record<string, number> = { monthly: 1, quarterly: 3, biannually: 6, yearly: 12, every_two_years: 24 };

type PartnerSeller = { user_id: bigint; external_user_id: string };

const badRequest = (message: string) => json({ success: false, message }, 400);

// Query strings can carry arrays and hashes (`page[]=2`), which have no `to_i`.
const integerParams = (params: Params, ...names: string[]) =>
  names.every((name) => isNil(params[name]) || typeof params[name] === "string" || typeof params[name] === "number");

const clamp = (value: bigint, min: bigint, max: bigint) => (value < min ? min : value > max ? max : value);

// `current_partner_application.partner_sellers.alive`, narrowed by `external_user_id`.
async function partnerSellersInScope(applicationId: unknown, params: Params): Promise<PartnerSeller[]> {
  let narrowing = Prisma.empty;
  if (present(params.external_user_id)) {
    // A collection's `to_s` is its Ruby inspect form, which only Rails can build.
    if (typeof params.external_user_id !== "string") throw new HandBackToRails("an external_user_id that is not a string");
    narrowing = Prisma.sql` AND ${column("partner_sellers", "external_user_id")} = ${params.external_user_id}`;
  }
  return selectRows<PartnerSeller>(
    Prisma.sql`SELECT ${column("partner_sellers", "user_id")}, ${column("partner_sellers", "external_user_id")} FROM ${table("partner_sellers")} WHERE ${column("partner_sellers", "oauth_application_id")} = ${applicationId} AND ${column("partner_sellers", "deleted_at")} IS NULL${narrowing} ORDER BY ${column("partner_sellers", "id")} ASC`,
  );
}

const isScalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);

// `params.permit(:query, :min_price, :max_price, :tags, tags: [])`
function permittedSearchParams(params: Params): Params {
  const permitted: Params = {};
  for (const key of ["query", "min_price", "max_price", "tags"]) {
    const value = params[key];
    if (isScalar(value) || value === null) permitted[key] = value;
    else if (key === "tags" && Array.isArray(value) && value.every((element) => isScalar(element) || element === null)) permitted[key] = value;
  }
  return permitted;
}

function jsonIds(value: unknown): bigint[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map((id) => BigInt(id as number)) : [];
}

// A seller with saved profile sections shows only the products in their product grids and featured product sections. A seller without
// saved sections shows every live product.
async function productIdsHiddenFromProfile(userIds: bigint[]): Promise<bigint[]> {
  if (userIds.length === 0) return [];
  const sections = await selectRows<{ seller_id: bigint; type: string; json_data: unknown }>(
    Prisma.sql`SELECT ${column("seller_profile_sections", "seller_id")}, ${column("seller_profile_sections", "type")}, ${column("seller_profile_sections", "json_data")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "product_id")} IS NULL AND ${columnIn("seller_profile_sections", "seller_id", userIds)} ORDER BY ${column("seller_profile_sections", "id")} ASC`,
  );
  const shownBySeller = new Map<bigint, Set<bigint>>();
  for (const section of sections) {
    const shown = shownBySeller.get(section.seller_id) ?? new Set<bigint>();
    shownBySeller.set(section.seller_id, shown);
    const data = (typeof section.json_data === "string" ? JSON.parse(section.json_data) : section.json_data) as Record<string, unknown> | null;
    if (section.type === "SellerProfileProductsSection") for (const id of jsonIds(data?.shown_products ?? [])) shown.add(id);
    else if (section.type === "SellerProfileFeaturedProductSection") {
      if (data?.featured_product_id == null) throw new HandBackToRails("a featured product section without a product");
      shown.add(BigInt(data.featured_product_id as number));
    }
  }
  if (shownBySeller.size === 0) return [];

  const hidden = [...shownBySeller].map(([sellerId, shown]) =>
    shown.size === 0
      ? Prisma.sql`${column("links", "user_id")} = ${sellerId}`
      : Prisma.sql`(${column("links", "user_id")} = ${sellerId} AND ${columnNotIn("links", "id", [...shown])})`,
  );
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE (${Prisma.join(hidden, " OR ")}) AND ${column("links", "purchase_disabled_at")} IS NULL AND ${column("links", "banned_at")} IS NULL AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)}`,
  );
  return rows.map((row) => row.id);
}

// product_search_params: nil is Rails' "Unknown category" answer.
async function productSearchParams(params: Params, partnerSellers: PartnerSeller[]): Promise<Params | null> {
  const searchParams = await normalizeSearchParamValues(permittedSearchParams(params), { validFilterTokens }, { actionControllerParams: true });
  if (present(params.category)) {
    const category = typeof params.category === "string" ? await categoryForPath(params.category) : undefined;
    if (category === undefined) return null;
    searchParams.taxonomy_id = category.id;
    searchParams.include_taxonomy_descendants = true;
  }
  const userIds = partnerSellers.map((seller) => seller.user_id);
  return {
    ...searchParams,
    sort: present(params.sort) ? params.sort : BEST_SELLERS,
    user_id: userIds,
    is_alive_on_profile: true,
    exclude_ids: await productIdsHiddenFromProfile(userIds),
  };
}

async function categoryForPath(path: string): Promise<ApiCategory | undefined> {
  return [...(await categoriesById()).values()].find((category) => category.path === path);
}

const idsForJson = (ids: unknown) => (Array.isArray(ids) ? ids.map((id) => (typeof id === "bigint" ? intJson(id) : id)) : ids);

async function runSearch(searchParams: Params) {
  const body = await searchOptions({ ...searchParams, user_id: idsForJson(searchParams.user_id), exclude_ids: idsForJson(searchParams.exclude_ids) }, defaultSearchProductsDeps());
  return searchProducts(body);
}

// PartnerSellerPresenter#props
async function sellerProps(partnerSeller: PartnerSeller, user: UserRow) {
  const record = user as never;
  return {
    external_user_id: partnerSeller.external_user_id,
    name: nameOrUsername(Users.load(record)),
    avatar_url: await avatarUrl(record),
    profile_url: profileUrl(record),
  };
}

// Link#rated_as_adult?
function ratedAsAdult(row: LinkRow, user: UserRow): boolean {
  if (LinkFlags.isSet(row.flags, "is_adult")) return true;
  const seller = Users.load(user as never);
  if (UserFlags.isSet(user.flags as bigint | number | null, "all_adult_products")) return true;
  return [row.name, row.description, user.name, username(seller), user.bio].some((text) => isAdult(text as string | null));
}

// CurrencyHelper#recurrence_label
function recurrenceLabel(recurrence: unknown, durationInMonths: unknown): string | null {
  if (typeof recurrence !== "string" || recurrence === "") return null;
  const months = MONTHS_IN_RECURRENCE[recurrence];
  if (months === undefined) throw new HandBackToRails(`recurrence ${recurrence}`);
  if (durationInMonths != null && durationInMonths === months) return "once";
  const base = RECURRENCE_LONG_INDICATOR[recurrence]!;
  return durationInMonths == null ? base : `${base} x ${Math.round((durationInMonths as number) / months)}`;
}

// PartnerProductPresenter#props
async function productProps(row: LinkRow, user: UserRow, partnerSeller: PartnerSeller, category: ApiCategory | undefined) {
  const card = await cardForWeb(row.id, { showSeller: false, computeDescription: false, computeInventory: false });
  const label = recurrenceLabel(card.recurrence, card.duration_in_months);
  return {
    id: card.id,
    permalink: card.permalink,
    name: row.name,
    native_type: row.native_type,
    url: longUrl(row, user),
    thumbnail_url: card.thumbnail_url,
    price_cents: card.price_cents,
    currency_code: card.currency_code,
    price_formatted: `${formattedPrice(card.currency_code as string, card.price_cents as number)}${card.is_pay_what_you_want ? "+" : ""}${label === null ? "" : ` ${label}`}`,
    is_pay_what_you_want: card.is_pay_what_you_want,
    is_recurring_billing: LinkFlags.isSet(row.flags, "is_recurring_billing"),
    ratings: card.ratings,
    rated_as_adult: ratedAsAdult(row, user),
    category: category === undefined ? null : { id: category.id, path: category.path, label: category.label },
    creator: await sellerProps(partnerSeller, user),
  };
}

async function requireUser(userId: bigint): Promise<UserRow> {
  const user = await findUserById(userId);
  if (user === null) throw new HandBackToRails("a partner seller without a user");
  return user;
}

registerApiV2({
  method: "GET",
  pattern: "/v2/partner/products",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  before: partnerGuards,
  async run({ token, params }: ApiV2Input) {
    if (!integerParams(params, "page", "per_page")) return json({ success: false, message: "page and per_page must be integers." }, 400);

    const page = clamp(toI(params.page), 1n, BigInt(Number.MAX_SAFE_INTEGER));
    const perPage = Number(clamp(toI(present(params.per_page) ? params.per_page : DEFAULT_PER_PAGE), 1n, BigInt(MAX_PER_PAGE)));
    const offset = (page - 1n) * BigInt(perPage);
    if (offset >= BigInt(MAX_RESULT_WINDOW))
      return badRequest(`Results are available up to ${MAX_RESULT_WINDOW}. Narrow the request with external_user_id or other filters.`);

    const partnerSellers = await partnerSellersInScope(token.application_id, params);
    const searchParams = await productSearchParams(params, partnerSellers);
    if (searchParams === null) return badRequest("Unknown category. Use a path from GET /v2/partner/categories.");
    const render = (products: Record<string, unknown>[], total: number) =>
      json({
        success: true,
        products,
        total,
        page: Number(page),
        per_page: perPage,
        next_page: Number(page) * perPage < Math.min(total, MAX_RESULT_WINDOW) ? Number(page) + 1 : null,
      });
    if (partnerSellers.length === 0) return render([], 0);

    // `from` is 1-based in search_options.
    const size = Math.min(perPage, MAX_RESULT_WINDOW - Number(offset));
    const found = await runSearch({ ...searchParams, from: Number(offset) + 1, size, track_total_hits: true });
    const rows: LinkRow[] = [];
    for (const id of found.ids) {
      const row = await findLink(BigInt(id));
      if (row !== null) rows.push(row);
    }
    // Stock is not indexed. `total` counts search matches; clients follow `next_page`, even for an empty page.
    const visible: LinkRow[] = [];
    for (const row of rows) {
      if (LinkFlags.isSet(row.flags, "hide_sold_out_variants") && (await remainingForSaleCount(row)) === 0) continue;
      visible.push(row);
    }

    const sellersByUserId = new Map(partnerSellers.map((seller) => [String(seller.user_id), seller]));
    const categories = await categoriesById();
    const products: Record<string, unknown>[] = [];
    for (const row of visible) {
      const partnerSeller = sellersByUserId.get(String(row.user_id));
      if (partnerSeller === undefined) throw new HandBackToRails("a product of a seller outside the partner's roster");
      const category = row.taxonomy_id == null ? undefined : categories.get(String(row.taxonomy_id));
      products.push(await productProps(row, await requireUser(partnerSeller.user_id), partnerSeller, category));
    }
    return render(products, found.total ?? 0);
  },
});

registerApiV2({
  method: "GET",
  pattern: "/v2/partner/creators/top",
  scopes: [PARTNER_SCOPE],
  requireScope: [PARTNER_SCOPE],
  ownerless: true,
  before: partnerGuards,
  async run({ token, params }: ApiV2Input) {
    if (!integerParams(params, "limit")) return json({ success: false, message: "limit must be an integer." }, 400);

    const limit = Number(clamp(toI(present(params.limit) ? params.limit : DEFAULT_LIMIT), 1n, BigInt(MAX_LIMIT)));
    const partnerSellers = await partnerSellersInScope(token.application_id, params);
    const searchParams = await productSearchParams(params, partnerSellers);
    if (searchParams === null) return badRequest("Unknown category. Use a path from GET /v2/partner/categories.");
    if (partnerSellers.length === 0) return json({ success: true, creators: [] });

    const found = await runSearch({ ...searchParams, size: 0, include_top_creators: true, top_creators_size: limit });
    const buckets = found.aggregations.top_creators?.buckets ?? [];
    const sellersByUserId = new Map(partnerSellers.map((seller) => [String(seller.user_id), seller]));
    const creators = [];
    for (const bucket of buckets) {
      const partnerSeller = sellersByUserId.get(String(toI(bucket.key)));
      if (partnerSeller !== undefined) creators.push(await sellerProps(partnerSeller, await requireUser(partnerSeller.user_id)));
    }
    return json({ success: true, creators });
  },
});
