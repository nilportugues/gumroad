// The small JSON endpoints around the product editor and the product page: TagsController#index, LinksController#cart_items_count,
// #increment_views and #track_user_action, Products::VariantsController#index, Products::OtherRefundPoliciesController#index and
// Products::AvailableOfferCodesController#index. Anything the port does not model (tiers, SKUs, option restrictions) goes to Rails
// before anything is written.
import { createHash, randomUUID } from "node:crypto";

import { Prisma, type Tag } from "@prisma/client";

import { encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { geoIpLookup } from "../infra/geo-ip.ts";
import { LinkFlags } from "../models/link.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { UserFlags } from "../models/user.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { fetchCart } from "../page-props/checkout/checkout.ts";
import { createUserEvent, referrerDomain, remoteIp } from "../page-props/audience/events.ts";
import { titleize } from "../html/installment-message.ts";
import { isBot } from "../page-props/discover/discover.ts";
import { authorize } from "../policies/authorize.ts";
import { collaboratingProductIds, linkPolicy, productsVariantsLinkPolicy } from "../policies/link.ts";
import { type SellerContext } from "../policies/seller-context.ts";
import { type ActionContext, type ActionResult, HandBackToRails, processAction, RoutingError } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { requestFormat } from "./rails-params.ts";
import { queryParam } from "./rails-request.ts";
import { authorizeJson, json } from "./seller-json.ts";
import { sellerJsonAction } from "./json-seller.ts";

const GUMROAD_GUID_COOKIE = "_gumroad_guid";
const TAGS_LIMIT = 10;
const REFERRER_MAX_LENGTH = 190;
// AvailableOfferCodesController
const MAX_OFFER_CODES_LIMIT = 20;
const INITIAL_OFFER_CODES_LIMIT = 5;
// OfferCode.search_by_name's own limit
const OFFER_CODE_SEARCH_LIMIT = 20;
const RECOMMENDED_REFERRER_DOMAIN = "recommended_by_gumroad";

const ASCII_ONLY = /^[\x00-\x7f]*$/u;
const present = (value: string | null | undefined): value is string => value != null && /[^\s]/u.test(value);
const isoMillis = (time: Date | null): string | null => (time === null ? null : time.toISOString());

// `params[:name]` as a plain string, else a hand-back (an array or hash parameter makes Rails call a String method on it).
function stringParam(request: ActionContext["request"], name: string): string | null | undefined {
  const query = request.queryString;
  if (new RegExp(`(^|&)${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(\\[|%5B)`, "iu").test(query)) throw new HandBackToRails(`a structured ${name} parameter`);
  return queryParam(request, name);
}

// ----- TagsController#index

const TAG_COLUMNS = ["id", "name", "created_at", "updated_at", "humanized_name", "flagged_at", "taggings_count"] as const;

async function tagsIndex({ request }: ActionContext): Promise<ActionResult> {
  const text = stringParam(request, "text");
  if (text === undefined) return json({ success: false });
  // `params[:text]` with no value is nil, which is falsy.
  if (text === null) return json({ success: false });
  // String#downcase is full Unicode, and `LIKE` treats the text as a pattern all the same.
  if (!ASCII_ONLY.test(text)) throw new HandBackToRails("a tag search with non-ASCII text");
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`tags`.*")}, ${column("tags", "taggings_count")} AS uses FROM ${table("tags")} WHERE ${column("tags", "name")} LIKE ${`${text.toLowerCase()}%`} ORDER BY ${column("tags", "taggings_count")} DESC, ${column("tags", "name")} ASC LIMIT ${TAGS_LIMIT}`,
  );
  const tags = rows.map((row) => {
    const tag = castRow<Tag>("Tag", row);
    // Tag#humanized_name: `self[:humanized_name] || name.titleize`
    if (tag.humanized_name === null && tag.name === null) throw new HandBackToRails("a tag without a name");
    const attributes = { ...tag, humanized_name: tag.humanized_name ?? titleize(tag.name!) };
    return {
      ...Object.fromEntries(TAG_COLUMNS.map((name) => [name, name === "created_at" || name === "updated_at" || name === "flagged_at" ? isoMillis(attributes[name] as Date | null) : attributes[name]])),
      uses: Number(row.uses),
    };
  });
  return json(tags);
}

export const tagsResponse = (incoming: Request): Promise<Response> => processAction(incoming, {}, tagsIndex);

// ----- LinksController#cart_items_count

async function cartItemsCount(action: ActionContext): Promise<ActionResult> {
  // `format.any` renders the Inertia frame.
  if (requestFormat(action.request) !== "json") throw new HandBackToRails("cart_items_count asked for something other than JSON");
  const user = railsLoggedInUser(action.context);
  const guid = action.request.cookies.get(GUMROAD_GUID_COOKIE) ?? null;
  const cart = await fetchCart(user?.id ?? null, guid);
  let count = 0;
  if (cart !== null) {
    const [row] = await selectRows<{ count: bigint | number }>(
      Prisma.sql`SELECT COUNT(*) AS count FROM ${table("cart_products")} WHERE ${column("cart_products", "cart_id")} = ${cart.id} AND ${column("cart_products", "deleted_at")} IS NULL`,
    );
    count = Number(row?.count ?? 0);
  }
  return json({ cart_items_count: count });
}

export const cartItemsCountResponse = (incoming: Request): Promise<Response> => processAction(incoming, {}, cartItemsCount);

// ----- LinksController#fetch_product: `Link.fetch(params[:id] || params[:link_id]) || e404`

type ProductRow = { id: bigint; user_id: bigint | null; price_cents: number | null; flags: bigint; name: string | null; unique_permalink: string | null; price_currency_type: string | null };

async function fetchVisibleProduct(permalink: string | null): Promise<ProductRow | null> {
  if (permalink === null) return null;
  const [row] = await selectRows<ProductRow>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "price_cents")}, ${column("links", "flags")}, ${column("links", "name")}, ${column("links", "unique_permalink")}, ${column("links", "price_currency_type")} FROM ${table("links")} WHERE ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

// `Link.find_by(unique_permalink:)`: deleted products included.
async function findProductByPermalink(permalink: string | null): Promise<ProductRow | null> {
  if (permalink === null || permalink === "") return null;
  const [row] = await selectRows<ProductRow>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "user_id")}, ${column("links", "price_cents")}, ${column("links", "flags")}, ${column("links", "name")}, ${column("links", "unique_permalink")}, ${column("links", "price_currency_type")} FROM ${table("links")} WHERE ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
  );
  return row ?? null;
}

function permalinkOf(input: MutationInput): string | null {
  const value = input.routeParams.id ?? input.routeParams.link_id ?? input.routeParams.product_id;
  return value ?? null;
}

// ----- LinksController#track_user_action

async function trackUserAction(input: MutationInput): Promise<ActionResult> {
  const product = await fetchVisibleProduct(permalinkOf(input));
  if (product === null) throw new RoutingError("Not Found");
  const user = railsLoggedInUser(input.context);
  // `create_user_event(params[:event_name]) unless logged_in_user == @product.user`
  if (user === null || user.id !== product.user_id) {
    const name = input.params.event_name;
    if (name !== undefined && name !== null) {
      if (typeof name !== "string") throw new HandBackToRails("a non-string event_name");
      if (name === "signup") throw new HandBackToRails("a signup event");
      if (user !== null || PERMITTED_EVENT_NAMES.has(name)) {
        await createUserEvent(name, {
          context: input.context,
          headers: input.request.headers,
          url: input.url,
          state: input.peekState(),
          params: input.params,
          product: { id: product.id, price_cents: product.price_cents },
        });
      }
    }
  }
  return json({ success: true });
}

// Event::PERMITTED_NAMES
const PERMITTED_EVENT_NAMES = new Set([
  "add_product_mobile_app",
  "audience_callout_dismissal",
  "chargeback",
  "delete_product_mobile_app",
  "edit_product_mobile_app",
  "first_purchase_on_profile_visit",
  "post_view",
  "product_purchase_recovery_click",
  "product_refund_policy_fine_print_view",
  "purchase",
  "refund",
  "service_charge",
  "settlement_declined",
  "social_connect_attempted",
  "social_connect_connected",
  "social_connect_failed",
  "social_connect_hold_released",
  "social_connect_offered",
  "social_connect_reviewed",
]);

// ----- LinksController#increment_views

const BOOLEAN_FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);

// `source_url = request.referrer if request.get?` and the signed analytics payload only matter for a GET; one without a token never
// counts, one with a token verifies a message the port does not read.
async function incrementViewsGet(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  if (requestFormat(action.request) === "other") throw new HandBackToRails("increment_views asked for a format other than JSON");
  if ((await fetchVisibleProduct(routeParams.id ?? null)) === null) throw new RoutingError("Not Found");
  if (present(queryParam(action.request, "analytics_token") ?? null)) throw new HandBackToRails("an increment_views GET carrying an analytics token");
  return json({ success: true });
}

async function incrementViews(input: MutationInput): Promise<ActionResult> {
  const { request, context, params } = input;
  // A GIF beacon answers the image.
  if (requestFormat(request) === "other") throw new HandBackToRails("increment_views asked for a format other than JSON");
  const product = await fetchVisibleProduct(input.routeParams.id ?? null);
  if (product === null) throw new RoutingError("Not Found");
  const user = railsLoggedInUser(context);
  const skip = isBot(request.headers.get("user-agent"), params as never) || (user !== null && (product.user_id === context.currentSeller?.id || UserFlags.isSet(user.flags, "is_team_member"))) || context.impersonatedUser != null;
  if (skip) return json({ success: true });

  const referrerParam = params.referrer;
  const referrerList = Array.isArray(referrerParam) ? referrerParam : referrerParam == null ? [] : [referrerParam];
  if (referrerList.some((entry) => typeof entry !== "string")) throw new HandBackToRails("a non-string referrer");
  for (const key of ["was_product_recommended", "view_url", "plugins"]) if (params[key] != null && typeof params[key] !== "string") throw new HandBackToRails(`a non-string ${key} parameter`);
  let referrer: string | null = (referrerList as string[]).filter(present).at(-1) ?? request.headers.get("referer");
  if (referrer !== null && present(referrer)) referrer = referrer.replace(/[^\x00-\x7f]/gu, "").slice(0, REFERRER_MAX_LENGTH + 1);
  const recommended = typeof params.was_product_recommended === "string" && params.was_product_recommended !== "" && !BOOLEAN_FALSE_VALUES.has(params.was_product_recommended);
  const ip = remoteIp(request.headers);
  const geo = geoIpLookup(ip);
  const agent = request.headers.get("user-agent");
  await performAsync("ElasticsearchIndexerWorker", [
    "index",
    {
      class_name: "ProductPageView",
      id: randomUUID(),
      body: {
        product_id: Number(product.id),
        country: geo?.countryName ?? null,
        state: geo?.regionName ?? null,
        referrer_domain: recommended ? RECOMMENDED_REFERRER_DOMAIN : referrerDomain(referrer),
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
        seller_id: product.user_id === null ? null : Number(product.user_id),
        user_id: user === null ? null : Number(user.id),
        ip_address: ip,
        url: (params.view_url as string | undefined) ?? input.url.pathname,
        browser_guid: request.cookies.get(GUMROAD_GUID_COOKIE) ?? null,
        browser_fingerprint: createHash("md5").update([agent ?? "", (params.plugins as string | undefined) ?? ""].join(",")).digest("hex"),
        referrer,
      },
    },
  ]);
  return json({ success: true });
}

// ----- Products::VariantsController#index

type VariantRow = { id: bigint; name: string | null; max_purchase_count: number | null; description: string | null; price_difference_cents: number | null; customizable_price: number | boolean | null; duration_in_minutes: number | null; sales_count_for_inventory_cache: number };

async function variantsIndex(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  return sellerJsonAction(action, () => true, async (sellerContext) => {
    const seller = action.context.currentSeller!;
    const product = await fetchOwnedProduct(routeParams.link_id ?? null, seller.id);
    const denied = await authorizeJson(action, () => authorize(productsVariantsLinkPolicy.index, sellerContext));
    if (denied) return denied;
    if (LinkFlags.isSet(product.flags, "is_tiered_membership") || LinkFlags.isSet(product.flags, "skus_enabled")) throw new HandBackToRails("options of a tiered membership or a product with SKUs");
    const [category] = await selectRows<{ id: bigint }>(
      Prisma.sql`SELECT ${column("variant_categories", "id")} FROM ${table("variant_categories")} WHERE ${column("variant_categories", "link_id")} = ${product.id} AND ${column("variant_categories", "deleted_at")} IS NULL ORDER BY ${column("variant_categories", "id")} ASC LIMIT 1`,
    );
    if (category === undefined) return json([]);
    const rows = await selectRows<VariantRow>(
      Prisma.sql`SELECT ${Prisma.raw("`base_variants`.*")} FROM ${table("base_variants")} WHERE ${column("base_variants", "type")} = 'Variant' AND ${column("base_variants", "variant_category_id")} = ${category.id} AND ${column("base_variants", "deleted_at")} IS NULL ORDER BY ${column("base_variants", "position_in_category")} ASC, ${column("base_variants", "created_at")} ASC`,
    );
    return json(
      rows.map((row) => ({
        id: externalId(row.id),
        name: row.name === "Untitled" ? product.name : (row.name ?? ""),
        quantity_left: row.max_purchase_count === null ? null : Math.max(row.max_purchase_count - Number(row.sales_count_for_inventory_cache ?? 0), 0),
        description: row.description ?? "",
        price_difference_cents: row.price_difference_cents,
        recurrence_price_values: null,
        is_pwyw: !!row.customizable_price,
        duration_in_minutes: row.duration_in_minutes,
      })),
    );
  });
}

// `Link.fetch(permalink, user: current_seller) || e404`
async function fetchOwnedProduct(permalink: string | null, sellerId: bigint): Promise<ProductRow> {
  const product = await fetchVisibleProduct(permalink);
  if (product === null || product.user_id !== sellerId) throw new RoutingError("Not Found");
  return product;
}

// ----- Products::OtherRefundPoliciesController#index and AvailableOfferCodesController#index

async function editableProduct(action: ActionContext, sellerContext: SellerContext, permalink: string | null): Promise<{ halt: ActionResult } | { halt: null; product: ProductRow }> {
  const product = await findProductByPermalink(permalink);
  if (product === null) throw new RoutingError("Not Found");
  const collaborating = await collaboratingProductIds(sellerContext, [product.id]);
  const denied = await authorizeJson(action, () => authorize((c, record) => linkPolicy.edit(c, record, collaborating), sellerContext, { id: product.id, user_id: product.user_id, flags: product.flags }));
  return denied ? { halt: denied } : { halt: null, product };
}

// RefundPolicy::ALLOWED_REFUND_PERIODS_IN_DAYS
const REFUND_PERIOD_TITLES = new Map<number, string>([
  [0, "No refunds allowed"],
  [7, "7-day money back guarantee"],
  [14, "14-day money back guarantee"],
  [30, "30-day money back guarantee"],
  [183, "6-month money back guarantee"],
]);

async function otherRefundPolicies(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  return sellerJsonAction(action, () => true, async (sellerContext) => {
    const found = await editableProduct(action, sellerContext, routeParams.product_id ?? null);
    if (found.halt) return found.halt;
    const { product } = found;
    const rows = await selectRows<{ id: bigint; fine_print: string | null; max_refund_period_in_days: number | null; name: string | null }>(
      Prisma.sql`SELECT ${Prisma.raw("`refund_policies`.*")}, ${column("links", "name")} FROM ${table("refund_policies")} INNER JOIN ${table("links")} ON ${column("links", "id")} = ${column("refund_policies", "product_id")}
        WHERE ${column("refund_policies", "seller_id")} = ${product.user_id} AND ${column("refund_policies", "product_id")} IS NOT NULL AND ${column("links", "deleted_at")} IS NULL AND ${LinkFlags.condition("archived", false)} AND ${column("refund_policies", "product_id")} <> ${product.id}
        ORDER BY ${column("refund_policies", "updated_at")} DESC`,
    );
    return json(
      rows.map((row) => ({
        fine_print: row.fine_print,
        id: externalId(row.id),
        max_refund_period_in_days: row.max_refund_period_in_days,
        product_name: row.name,
        title: REFUND_PERIOD_TITLES.get(row.max_refund_period_in_days ?? -1) ?? null,
      })),
    );
  });
}

type OfferCodeRow = {
  id: number;
  name: string | null;
  code: string | null;
  amount_cents: number | null;
  amount_percentage: number | null;
  universal: number | boolean;
  expires_at: Date | null;
  minimum_quantity: number | null;
  duration_in_months: number | null;
  minimum_amount_cents: number | null;
  flags: bigint;
  ownership_duration_tiers: unknown;
  created_at: Date;
};

const ONCE_PER_CART_FLAG = 4n; // OfferCode flag 3

async function availableOfferCodes(action: ActionContext, routeParams: Record<string, string>): Promise<ActionResult> {
  return sellerJsonAction(action, () => true, async (sellerContext) => {
    const found = await editableProduct(action, sellerContext, routeParams.product_id ?? null);
    if (found.halt) return found.halt;
    const { product } = found;
    const query = stringParam(action.request, "query");
    if (query != null && !ASCII_ONLY.test(query)) throw new HandBackToRails("an offer code search with non-ASCII text");
    const searching = present(query);
    const limit = searching ? MAX_OFFER_CODES_LIMIT : INITIAL_OFFER_CODES_LIMIT;
    const nameFilter = searching ? Prisma.sql` AND LOWER(${column("offer_codes", "name")}) LIKE ${`%${query.trim().toLowerCase()}%`}` : Prisma.empty;
    const order = searching ? Prisma.sql` ORDER BY ${column("offer_codes", "created_at")} DESC LIMIT ${OFFER_CODE_SEARCH_LIMIT}` : Prisma.empty;
    const productCodes = await selectRows<OfferCodeRow>(
      Prisma.sql`SELECT ${Prisma.raw("`offer_codes`.*")} FROM ${table("offer_codes")} INNER JOIN ${table("offer_codes_products")} ON ${column("offer_codes", "id")} = ${column("offer_codes_products", "offer_code_id")}
        WHERE ${column("offer_codes_products", "product_id")} = ${product.id} AND ${column("offer_codes", "deleted_at")} IS NULL AND ${column("offer_codes", "new_customers_only")} = FALSE${nameFilter}${order}`,
    );
    const universalCodes = await selectRows<OfferCodeRow>(
      Prisma.sql`SELECT ${Prisma.raw("`offer_codes`.*")} FROM ${table("offer_codes")}
        WHERE ${column("offer_codes", "user_id")} = ${product.user_id} AND (universal = 1 AND (currency_type = ${product.price_currency_type} OR currency_type IS NULL)) AND ${column("offer_codes", "deleted_at")} IS NULL
        AND NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${product.id})
        AND ${column("offer_codes", "new_customers_only")} = FALSE${nameFilter}${order}`,
    );
    // `(product_codes + universal_codes).sort_by(&:created_at).reverse!.first(limit)`
    const combined = [...productCodes, ...universalCodes].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).reverse().slice(0, limit);
    const props = [];
    for (const code of combined) props.push(await offerCodeProps(code));
    return json(props);
  });
}

async function offerCodeProps(code: OfferCodeRow): Promise<Record<string, unknown>> {
  const tiers = code.ownership_duration_tiers;
  const tiered = typeof tiers === "string" ? (JSON.parse(tiers) as unknown[]).length > 0 : Array.isArray(tiers) && tiers.length > 0;
  const isCents = code.amount_cents != null;
  if (tiered) throw new HandBackToRails("a tiered offer code");
  if (isCents && (code.flags & ONCE_PER_CART_FLAG) !== 0n) throw new HandBackToRails("a once-per-cart offer code");
  const variant = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table("offer_codes_variants")} WHERE ${column("offer_codes_variants", "offer_code_id")} = ${code.id} LIMIT 1`);
  if (variant.length > 0) throw new HandBackToRails("an offer code limited to options");
  const universal = !!code.universal;
  let productIds: string[] | null = null;
  const excluded: string[] = [];
  if (universal) {
    for (const row of await selectRows<{ product_id: bigint }>(Prisma.sql`SELECT ${column("offer_codes_excluded_products", "product_id")} FROM ${table("offer_codes_excluded_products")} WHERE ${column("offer_codes_excluded_products", "offer_code_id")} = ${code.id}`)) excluded.push(externalId(row.product_id));
  } else {
    productIds = (await selectRows<{ product_id: bigint }>(Prisma.sql`SELECT ${column("offer_codes_products", "product_id")} FROM ${table("offer_codes_products")} WHERE ${column("offer_codes_products", "offer_code_id")} = ${code.id}`)).map((row) => externalId(row.product_id));
  }
  const discount: Record<string, unknown> = {
    ...(isCents ? { type: "fixed", cents: code.amount_cents } : { type: "percent", percents: code.amount_percentage }),
    product_ids: productIds,
    expires_at: isoMillis(code.expires_at),
    minimum_quantity: code.minimum_quantity,
    duration_in_billing_cycles: code.duration_in_months,
    minimum_amount_cents: code.minimum_amount_cents,
  };
  if (excluded.length > 0) discount.excluded_product_ids = excluded;
  return { id: externalId(code.id), code: code.code, name: present(code.name) ? code.name : "", discount };
}

// A seller JSON GET: the route's params ride in from the App Router.
const routeParamsOf = (params: Promise<Record<string, string>>) => params;

export const variantsResponse = (incoming: Request, params: Promise<Record<string, string>>): Promise<Response> =>
  routeParamsOf(params).then((routeParams) => processAction(incoming, {}, (action) => variantsIndex(action, routeParams)));
export const otherRefundPoliciesResponse = (incoming: Request, params: Promise<Record<string, string>>): Promise<Response> =>
  routeParamsOf(params).then((routeParams) => processAction(incoming, {}, (action) => otherRefundPolicies(action, routeParams)));
export const availableOfferCodesResponse = (incoming: Request, params: Promise<Record<string, string>>): Promise<Response> =>
  routeParamsOf(params).then((routeParams) => processAction(incoming, {}, (action) => availableOfferCodes(action, routeParams)));
export const incrementViewsGetResponse = (incoming: Request, params: Promise<Record<string, string>>): Promise<Response> =>
  routeParamsOf(params).then((routeParams) => processAction(incoming, {}, (action) => incrementViewsGet(action, routeParams)));

registerMutations(
  { method: "POST", pattern: "/links/:id/track_user_action", formats: ["any"], run: trackUserAction },
  {
    method: "POST",
    pattern: "/links/:id/increment_views",
    formats: ["any"],
    run: incrementViews,
  },
);
