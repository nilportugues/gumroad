// Bodies of the pure-read tools of app/services/mcp/server.rb: get_account, list_payouts, get_customers and get_sales_totals.
// Every other tool still runs in Rails (toolBody returns undefined for it). A call whose token lacks the tool's scope also
// stays in Rails, which owns the 403 scope challenge and the batch variant of that error. So do these sub-cases:
// get_customers with a date in an ISO 8601 form other than YYYY-MM-DD, YYYYMMDD or either with a time, or a query timeout,
// and get_sales_totals with a country, day, week or month breakdown (tzinfo transitions, Compliance::Countries).
import { Prisma } from "@prisma/client";
import type { OauthAccessToken, ProductFile, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { hasApplicableOfferCodes, validityPeriodOf } from "../controllers/api-v2/offer-codes.ts";
import { isPublishedProduct, plannedDescription } from "../controllers/api-v2/product-writes.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { getRedis } from "../infra/redis.ts";
import { findByName } from "../models/compliance-countries.ts";
import { setJsonDataForAttr } from "../models/concerns/json-data.ts";
import { RubyHash, type YamlValue } from "../models/concerns/psych.ts";
import {
  instantInTimeZoneIso8601,
  InvalidTimeZoneError,
  startOfDayIso8601,
  utcOffsetAt,
} from "../models/concerns/rails-time-zone.ts";
import { rubySortByInteger } from "../models/concerns/ruby-sort-by.ts";
import { rubyFloatToS } from "../models/concerns/ruby-values.ts";
import { createApiLink, type CreateSeller } from "../models/link-create.ts";
import { successfulSalesCount, totalUsdCents } from "../models/link-metrics.ts";
import { assertPlainPublish, publishBang } from "../models/link-publish.ts";
import { Links } from "../models/link.ts";
import {
  addProduct,
  assertPlainCode,
  assertPlainProducts,
  buildOfferCode,
  EXPIRING_CONTEXT,
  loadOfferCode,
  OfferCodes,
  productsOfOfferCode,
  universalProducts,
} from "../models/offer-code-writes.ts";
import { OfferCodeFlags } from "../models/offer-code.ts";
import { planBuyPriceWrite, PRICE_TOO_LARGE as PRICE_WRITE_TOO_LARGE, writeBuyPrice } from "../models/price-writes.ts";
import { s3Fields } from "../models/product-file.ts";
import { planTagChanges, saveTags } from "../models/product-tags.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { selectRows } from "../models/sql.ts";
import { SubscriptionFlags } from "../models/subscription.ts";
import { NotPortedError, UserFlags } from "../models/user.ts";
import { CreatorAnalyticsCachingProxy } from "../page-props/analytics/caching-proxy.ts";
import { churnData } from "../page-props/analytics/churn.ts";
import { displayExtension, nameDisplayable } from "../page-props/audience/product-file-json.ts";
import { subscriptionStatus } from "../page-props/customers/customers.ts";
import { domainConfig } from "../page-props/domain.ts";
import { taxonomyLabelOrNull } from "../presenters/discover/seo.ts";
import type { LinkRow, UserRow } from "../presenters/product-reads.ts";
import { longUrl } from "../presenters/product.ts";
import { TimeZoneNotPortedError } from "../search/civil-time.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { LEGACY_SCOPES, MCP_SCOPES } from "./constants.ts";

const INVALID_PARAMS = -32602;
const MICROSECONDS_PER_SECOND = 1_000_000n;
// Mcp::Server::MAX_DATETIME_YEAR, as the first second of the year after it.
const FIRST_UNSUPPORTED_SECOND = 253_402_300_800n;
const DEFAULT_PAYOUTS = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const CUSTOMERS_DEFAULT_ROWS = 25;
const CUSTOMERS_QUERY_TIMEOUT_MS = 30_000;
const TOTALS_DEFAULT_DAYS = 30;
const TOTALS_MAX_DAYS = 366;
const TOTALS_MAX_ROWS = 100;
const MAX_SUPPORTED_YEAR = 9998;
const DAY_MS = 86_400_000;
const USD = "usd";
// Rails stores a description as sent; only whole paragraphs of plain text are recorded.
const PARAGRAPH_DESCRIPTION = /^(?:<p>[^<>&]*<\/p>)+$/u;
const CHARGED_SUCCESS_STATES = ["preorder_authorization_successful", "successful"];
const KEPT_SUCCESS_STATES = ["successful", "preorder_authorization_successful", "gift_receiver_purchase_successful"];
const CUSTOMER_REFUNDED = "COALESCE(purchases.stripe_refunded, 0) = 1";
const CUSTOMER_FREE = "COALESCE(purchases.price_cents, 0) = 0";

type Hash = Record<string, unknown>;

// An Mcp::Server::Error: the JSON-RPC error the caller gets. server.ts maps it to its McpError.
export class ToolRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

// An Mcp::Server::ToolError: a tool-level failure, answered as a result with `isError` rather than a JSON-RPC error.
export class ToolError extends Error {}

export type PayoutRow = {
  id: bigint;
  amount_cents: bigint | null;
  currency: string | null;
  state: string | null;
  created_at: Date | null;
};
// `user.payments` in (created_at, id) descending order, strictly after `after` when given, at most `limit` rows.
export type PayoutReader = (
  userId: bigint,
  limit: number,
  after: { at: string; id: bigint } | null,
) => Promise<PayoutRow[]>;

export type CustomerQuery = {
  sellerId: bigint;
  email: string | null;
  // Bounds on purchases.created_at as UTC datetimes: `from` inclusive, `until` exclusive.
  from: string | null;
  until: string | null;
  limit: number;
};
export type CustomerSpendRow = {
  email: string | null;
  orders: number;
  spend_cents: number;
  refunded_cents: number;
  chargedback_cents: number;
  first_at: Date | null;
  last_at: Date | null;
};
export type CustomerConversionRow = { email: string | null; free_at: Date; converted_at: Date };
export type CustomerReader = {
  spend: (query: CustomerQuery) => Promise<CustomerSpendRow[]>;
  conversion: (query: CustomerQuery) => Promise<CustomerConversionRow[]>;
};

export type ProductTotalsQuery = { sellerId: bigint; productId: bigint | null; from: string; until: string };
export type ProductTotalsRow = { link_id: bigint; revenue_cents: number; units: number };
export type CountryTotalsRow = { country: string | null; revenue_cents: number; units: number };
// One constant-offset stretch of the range; `from` is inclusive, `until` exclusive, both UTC datetimes.
export type OffsetSegment = { from: string; until: string; offsetSeconds: number };
export type PeriodTotalsRow = { key: string; revenue_cents: number; units: number };
export type SalesTotalsReader = {
  byProduct: (query: ProductTotalsQuery) => Promise<ProductTotalsRow[]>;
  // The raw `COALESCE(NULLIF(TRIM(country), ''), ip_country)` groups; naming them is the caller's.
  byCountry: (query: ProductTotalsQuery) => Promise<CountryTotalsRow[]>;
  // Local-date buckets (`YYYY-MM-DD`: the day, the Monday of its week or the first of its month) of each segment.
  byPeriod: (
    query: Omit<ProductTotalsQuery, "from" | "until"> & { segments: OffsetSegment[]; period: "day" | "week" | "month" },
  ) => Promise<PeriodTotalsRow[]>;
  productNames: (ids: bigint[]) => Promise<Map<bigint, string>>;
  // user.links.find_by_external_id, then unique_permalink, then custom_permalink; a deleted product is not found.
  findProductId: (userId: bigint, id: string) => Promise<bigint | null>;
};

export type SaleRow = {
  id: bigint;
  email: string | null;
  link_id: bigint | null;
  product_name: string | null;
  price_cents: number | null;
  fee_cents: number | null;
  affiliate_credit_cents: number | null;
  created_at: Date;
  stripe_refunded: boolean;
  chargeback_date: Date | null;
  subscription_id: bigint | null;
  subscription_flags: bigint | null;
  country: string | null;
  ip_country: string | null;
  offer_code: string | null;
  referrer: string | null;
  utm_driven_count: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
};
export type SalesQuery = {
  sellerId: bigint;
  email: string | null;
  productId: bigint | null;
  // UTC datetimes: `after` inclusive, `before` exclusive.
  after: string | null;
  before: string | null;
  payment: "paid" | "free" | null;
  kind: "subscription" | "one_time" | null;
  cursor: { at: string; id: bigint } | null;
  limit: number;
};
export type SalesReader = {
  list: (query: SalesQuery) => Promise<SaleRow[]>;
  findProductId: SalesTotalsReader["findProductId"];
};

// A purchase in the buyer's own library (list_purchases).
export type LibraryPurchaseRow = {
  id: bigint;
  link_id: bigint;
  product_exists: boolean;
  product_name: string | null;
  product_permalink: string | null;
  seller_id: bigint | null;
  seller_name: string | null;
  seller_username: string | null;
  displayed_price_cents: number | null;
  displayed_price_currency_type: string | null;
  created_at: Date;
  stripe_refunded: boolean;
};
export type LibraryQuery = { buyerId: bigint; cursor: { at: string; id: bigint } | null; limit: number };
export type LibraryReader = { list: (query: LibraryQuery) => Promise<LibraryPurchaseRow[]> };

export type ProductListRow = {
  id: bigint;
  created_at: Date;
  name: string | null;
  // Product::Prices#price_cents reads the default Price row, not the column: the alive buy prices in the product's currency.
  buy_price_count: number;
  buy_price_cents: number | null;
  purchase_type: number | null;
  price_currency_type: string | null;
  customizable_price: boolean | null;
  suggested_price_cents: number | null;
  purchase_disabled_at: Date | null;
  draft: boolean | null;
  flags: bigint | null;
  unique_permalink: string | null;
  custom_permalink: string | null;
};
export type ProductDetailRow = ProductListRow & { description: string | null };
export type ProductFileRow = {
  id: bigint;
  display_name: string | null;
  url: string | null;
  filetype: string | null;
  size: bigint | null;
  position: number | null;
};
export type CoverRow = { guid: string | null; unsplash_url: string | null; has_oembed: boolean };
export type ProductsReader = {
  // `user.products.visible`, newest first, strictly after `after` when given, at most `limit` rows.
  list: (userId: bigint, limit: number, after: { at: string; id: bigint } | null) => Promise<ProductListRow[]>;
  // `find_product!`'s row (null when the lookup finds nothing or the product is deleted), with its description.
  find: (userId: bigint, id: string) => Promise<ProductDetailRow | null>;
  // `alive_product_files` (`alive.in_order`) of a product.
  files: (productId: bigint) => Promise<ProductFileRow[]>;
  // `display_asset_previews` (`alive.in_order`) of a product.
  covers: (productId: bigint) => Promise<CoverRow[]>;
};

// What Mcp::Server adds to a product's payload beyond product_payload (category_payload, custom_summary, additional_details_payload,
// product.tags, the two receipt texts), and the members of a bundle (bundle_products_payload).
export type ProductExtras = {
  category: { path: string; label: string } | null;
  summary: unknown;
  additional_details: { name: unknown; value: unknown }[];
  tags: (string | null)[];
  custom_receipt_text: unknown;
  custom_view_content_button_text: unknown;
};
export type BundleMemberPayload = { id: string; name: string | null; variant_id: string | null; quantity: number };

export type ToolContext = {
  user: User;
  productExtras?: (productId: bigint) => Promise<ProductExtras>;
  bundleProducts?: (bundleId: bigint) => Promise<BundleMemberPayload[]>;
  token: OauthAccessToken;
  payouts?: PayoutReader;
  customers?: CustomerReader;
  salesTotals?: SalesTotalsReader;
  sales?: SalesReader;
  library?: LibraryReader;
  products?: ProductsReader;
  // Link#successful_sales_count and Link#total_usd_cents (both Elasticsearch searches).
  analytics?: AnalyticsReader;
  subscriptions?: SubscriptionsReader;
  churn?: ChurnReader;
  productStats?: (productId: bigint) => Promise<{ sales_count: number | null; sales_usd_cents: FloatValue | number }>;
  now?: () => Date;
};

export const readPayouts: PayoutReader = (userId, limit, after) =>
  after === null
    ? db.payment.findMany({
        where: { user_id: userId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: limit,
        select: { id: true, amount_cents: true, currency: true, state: true, created_at: true },
      })
    : // Raw so the microsecond cursor reaches MySQL as written, not rounded to a JavaScript millisecond.
      db.$queryRaw<PayoutRow[]>`SELECT id, amount_cents, currency, state, created_at FROM payments
        WHERE user_id = ${userId} AND (created_at < ${after.at} OR (created_at = ${after.at} AND id < ${after.id}))
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`;

// Mcp::Server#require_scopes! failing: `scope` is what a client steps up to (the scopes the token holds plus the first one it may
// request), or null when it registered none of the accepted scopes and the caller gets a plain error with no challenge.
export class ScopeError extends Error {
  constructor(
    message: string,
    readonly scope: string | null,
  ) {
    super(message);
  }
}

// Array#to_sentence with " or " for both connectors.
function orSentence(words: string[]): string {
  if (words.length <= 2) return words.join(" or ");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]!}`;
}

// Mcp::Server#obtainable_scope: DynamicClientOauth.requestable_scopes of the token's application, blank meaning any.
async function obtainableScope(token: OauthAccessToken, scopes: string[]): Promise<string | null> {
  const application = await db.oauthApplication.findUnique({
    where: { id: token.application_id },
    select: { scopes: true, mcp_dynamic_client: true },
  });
  if (application === null) throw new HandBackToRails("an MCP token whose application is missing");
  const own = application.scopes.split(" ").filter((scope) => scope !== "");
  const registered = application.mcp_dynamic_client ? [...own, ...MCP_SCOPES, ...LEGACY_SCOPES] : own;
  return scopes.find((scope) => registered.length === 0 || registered.includes(scope)) ?? null;
}

// Mcp::Server#require_scopes!, for a token that passes; a failure raises the ScopeError the server answers.
async function requireScopes(token: OauthAccessToken, scopes: string[], subject = "This tool"): Promise<void> {
  const held = (token.scopes ?? "").split(/\s+/u).filter((scope) => scope !== "");
  if (scopes.some((scope) => held.includes(scope))) return;
  // Doorkeeper lists a scope once; a repeated one is left to Rails.
  if (new Set(held).size !== held.length) throw new HandBackToRails("a token whose scopes repeat");
  const missing = await obtainableScope(token, scopes);
  throw new ScopeError(
    `${subject} requires the ${orSentence(scopes)} scope.`,
    missing === null ? null : [...held, missing].join(" "),
  );
}

const iso8601 = (time: Date): string => `${time.toISOString().slice(0, 19)}Z`;

// Mcp::Server#limit_for
function limitFor(args: Hash, fallback: number): number {
  const limit = "limit" in args ? (args.limit as number) : fallback;
  if (!(limit >= MIN_LIMIT && limit <= MAX_LIMIT))
    throw new ToolRpcError("limit must be between 1 and 50", INVALID_PARAMS);
  return limit;
}

// The cursor of Mcp::Server#paginate: created_at in microseconds, an underscore, the row id.
function parseCursor(args: Hash): { at: string; id: bigint } | null {
  const cursor = args.cursor;
  if (typeof cursor !== "string" || cursor.trim() === "") return null;
  const separator = cursor.indexOf("_");
  const at = separator === -1 ? cursor : cursor.slice(0, separator);
  const id = separator === -1 ? "" : cursor.slice(separator + 1);
  if (!/^\d+$/u.test(at) || !/^\d+$/u.test(id)) throw new ToolRpcError("cursor is not valid", INVALID_PARAMS);
  const micros = BigInt(at);
  if (micros / MICROSECONDS_PER_SECOND >= FIRST_UNSUPPORTED_SECOND)
    throw new ToolRpcError("cursor is not valid", INVALID_PARAMS);
  const seconds = new Date(Number(micros / MICROSECONDS_PER_SECOND) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return { at: `${seconds}.${(micros % MICROSECONDS_PER_SECOND).toString().padStart(6, "0")}`, id: BigInt(id) };
}

const utc = (time: Date): string => time.toISOString().slice(0, 19).replace("T", " ");
const num = (value: unknown): number => Number(value);
const flagSql = (name: Parameters<typeof PurchaseFlags.bit>[0], enabled: boolean) =>
  PurchaseFlags.condition(name, enabled);
// An unreversed chargeback; a won dispute keeps the money.
const CHARGEDBACK = `purchases.chargeback_date IS NOT NULL AND COALESCE(purchases.flags & ${PurchaseFlags.bit("chargeback_reversed")}, 0) = 0`;
const TIMEOUT_HINT = Prisma.raw(`/*+ MAX_EXECUTION_TIME(${CUSTOMERS_QUERY_TIMEOUT_MS}) */`);

// user.sales.successful_or_preorder_authorization_successful, narrowed by the tool's filters.
function customerConditions(query: CustomerQuery): Prisma.Sql {
  const conditions = [
    Prisma.sql`purchases.seller_id = ${query.sellerId}`,
    Prisma.sql`purchases.purchase_state IN (${Prisma.join(CHARGED_SUCCESS_STATES)})`,
  ];
  if (query.email !== null) conditions.push(Prisma.sql`purchases.email = ${query.email}`);
  if (query.from !== null) conditions.push(Prisma.sql`purchases.created_at >= ${query.from}`);
  if (query.until !== null) conditions.push(Prisma.sql`purchases.created_at < ${query.until}`);
  return Prisma.join(conditions, " AND ");
}

export const readCustomers: CustomerReader = {
  async spend(query) {
    const conditions = customerConditions(query);
    // Refunds per purchase, pre-aggregated: joined directly they would multiply the buyer's orders.
    const refunds = Prisma.sql`SELECT refunds.purchase_id, SUM(refunds.amount_cents) AS amount_cents FROM refunds
      INNER JOIN purchases ON purchases.id = refunds.purchase_id
      WHERE (refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled')
        OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')
      AND ${conditions} GROUP BY refunds.purchase_id`;
    const refunded = "COALESCE(refund_totals.amount_cents, 0)";
    const spend = Prisma.raw(
      `SUM(CASE WHEN ${CUSTOMER_REFUNDED} OR ${CHARGEDBACK} THEN 0 ELSE GREATEST(COALESCE(purchases.price_cents, 0) - ${refunded}, 0) END)`,
    );
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${TIMEOUT_HINT}
        purchases.email AS email, COUNT(*) AS orders, ${spend} AS spend_cents,
        ${Prisma.raw(`SUM(CASE WHEN ${CUSTOMER_REFUNDED} THEN COALESCE(purchases.price_cents, 0) ELSE ${refunded} END)`)} AS refunded_cents,
        ${Prisma.raw(`SUM(CASE WHEN ${CHARGEDBACK} THEN COALESCE(purchases.price_cents, 0) ELSE 0 END)`)} AS chargedback_cents,
        MIN(purchases.created_at) AS first_at, MAX(purchases.created_at) AS last_at
      FROM purchases LEFT JOIN (${refunds}) refund_totals ON refund_totals.purchase_id = purchases.id
      WHERE ${conditions} GROUP BY purchases.email ORDER BY ${spend} DESC, purchases.email ASC LIMIT ${query.limit}`;
    return rows.map((row) => ({
      email: row.email as string | null,
      orders: num(row.orders),
      spend_cents: num(row.spend_cents),
      refunded_cents: num(row.refunded_cents),
      chargedback_cents: num(row.chargedback_cents),
      first_at: row.first_at as Date | null,
      last_at: row.last_at as Date | null,
    }));
  },
  async conversion(query) {
    // Paid and kept: a fully refunded or charged-back order is not money the buyer left behind.
    const paid = `COALESCE(purchases.price_cents, 0) > 0 AND NOT (${CUSTOMER_REFUNDED}) AND NOT (${CHARGEDBACK})`;
    const freeAt = `MIN(CASE WHEN ${CUSTOMER_FREE} THEN purchases.created_at END)`;
    const convertedAt = `MIN(CASE WHEN ${paid} THEN purchases.created_at END)`;
    const freeId = `MIN(CASE WHEN ${CUSTOMER_FREE} THEN purchases.id END)`;
    const convertedId = `MIN(CASE WHEN ${paid} THEN purchases.id END)`;
    // created_at has no fractional seconds, so two orders in the same second are settled by id.
    const convertedAfterFree = Prisma.raw(
      `${freeAt} = MIN(purchases.created_at) AND (${convertedAt} > ${freeAt} OR (${convertedAt} IS NOT NULL AND ${convertedAt} = ${freeAt} AND ${convertedId} > ${freeId}))`,
    );
    // The free purchase can predate the range: the range bounds the purchase that converted.
    const having = [convertedAfterFree];
    if (query.from !== null) having.push(Prisma.sql`${Prisma.raw(convertedAt)} >= ${query.from}`);
    if (query.until !== null) having.push(Prisma.sql`${Prisma.raw(convertedAt)} < ${query.until}`);
    // Ordered by the interval: MySQL's `-` on two DATETIMEs subtracts YYYYMMDDhhmmss numbers.
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${TIMEOUT_HINT}
        purchases.email AS email, ${Prisma.raw(freeAt)} AS free_at, ${Prisma.raw(convertedAt)} AS converted_at
      FROM purchases WHERE ${customerConditions({ ...query, from: null, until: null })}
      GROUP BY purchases.email HAVING ${Prisma.join(having, " AND ")}
      ORDER BY TIMESTAMPDIFF(SECOND, ${Prisma.raw(freeAt)}, ${Prisma.raw(convertedAt)}) ASC, purchases.email ASC LIMIT ${query.limit}`;
    return rows.map((row) => ({
      email: row.email as string | null,
      free_at: row.free_at as Date,
      converted_at: row.converted_at as Date,
    }));
  },
};

// The revenue definition of the report: kept, not refunded or charged back, not a bundle member, not a gift receiver's row.
function keptSalesConditions(sellerId: bigint, productId: bigint | null, from: string, until: string): Prisma.Sql[] {
  const conditions = [
    Prisma.sql`purchases.seller_id = ${sellerId}`,
    Prisma.sql`purchases.purchase_state IN (${Prisma.join(KEPT_SUCCESS_STATES)})`,
    Prisma.sql`(purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)`,
    Prisma.sql`(purchases.chargeback_date IS NULL OR purchases.flags & ${String(PurchaseFlags.bit("chargeback_reversed"))} != 0)`,
    flagSql("is_gift_receiver_purchase", false),
    flagSql("is_bundle_product_purchase", false),
    Prisma.sql`purchases.created_at >= ${from}`,
    Prisma.sql`purchases.created_at < ${until}`,
  ];
  if (productId !== null) conditions.push(Prisma.sql`purchases.link_id = ${productId}`);
  return conditions;
}
// A commission completion is a second payment on the order: it adds revenue but not a unit.
const unitsSql = () =>
  Prisma.sql`SUM(CASE WHEN ${flagSql("is_commission_completion_purchase", false)} THEN 1 ELSE 0 END)`;

export const readSalesTotals: SalesTotalsReader = {
  async byProduct(query) {
    const conditions = keptSalesConditions(query.sellerId, query.productId, query.from, query.until);
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT purchases.link_id AS link_id,
        SUM(purchases.price_cents) AS revenue_cents, ${unitsSql()} AS units
      FROM purchases WHERE ${Prisma.join(conditions, " AND ")} GROUP BY purchases.link_id ORDER BY purchases.link_id`;
    return rows.map((row) => ({
      link_id: BigInt(row.link_id as bigint),
      revenue_cents: num(row.revenue_cents),
      units: num(row.units),
    }));
  },
  async byCountry(query) {
    const conditions = keptSalesConditions(query.sellerId, query.productId, query.from, query.until);
    const key = Prisma.raw("COALESCE(NULLIF(TRIM(purchases.country), ''), purchases.ip_country)");
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${key} AS country,
        SUM(purchases.price_cents) AS revenue_cents, ${unitsSql()} AS units
      FROM purchases WHERE ${Prisma.join(conditions, " AND ")} GROUP BY ${key}`;
    return rows.map((row) => ({
      country: row.country as string | null,
      revenue_cents: num(row.revenue_cents),
      units: num(row.units),
    }));
  },
  async byPeriod(query) {
    const out: PeriodTotalsRow[] = [];
    for (const segment of query.segments) {
      const conditions = keptSalesConditions(query.sellerId, query.productId, segment.from, segment.until);
      const local = `DATE(DATE_ADD(purchases.created_at, INTERVAL ${Math.trunc(segment.offsetSeconds)} SECOND))`;
      const bucket =
        query.period === "day"
          ? local
          : query.period === "week"
            ? `DATE_SUB(${local}, INTERVAL WEEKDAY(${local}) DAY)`
            : `DATE_FORMAT(${local}, '%Y-%m-01')`;
      const expression = Prisma.raw(`DATE_FORMAT(${bucket}, '%Y-%m-%d')`);
      const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${expression} AS bucket,
          SUM(purchases.price_cents) AS revenue_cents, ${unitsSql()} AS units
        FROM purchases WHERE ${Prisma.join(conditions, " AND ")} GROUP BY ${expression}`;
      for (const row of rows)
        out.push({ key: String(row.bucket), revenue_cents: num(row.revenue_cents), units: num(row.units) });
    }
    return out;
  },
  async productNames(ids) {
    const links = await db.link.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(links.map((link) => [link.id, link.name]));
  },
  findProductId: (userId, id) => findSellerProductId(userId, id),
};

// Mcp::Server#find_product!'s lookup: user.links.find_by_external_id, then unique_permalink, then custom_permalink.
// A deleted product is not found.
async function findSellerProductId(userId: bigint, id: string): Promise<bigint | null> {
  const decrypted = decrypt(id);
  const attempts = [
    ...(decrypted === null ? [] : [{ id: BigInt(decrypted) }]),
    { unique_permalink: id },
    { custom_permalink: id },
  ];
  for (const where of attempts) {
    const link = await db.link.findFirst({
      where: { user_id: userId, ...where },
      select: { id: true, deleted_at: true },
    });
    if (link !== null) return link.deleted_at === null ? link.id : null;
  }
  return null;
}

export const readSales: SalesReader = {
  findProductId: (userId, id) => findSellerProductId(userId, id),
  async list(query) {
    const conditions = [
      Prisma.sql`purchases.seller_id = ${query.sellerId}`,
      Prisma.sql`purchases.purchase_state IN (${Prisma.join(CHARGED_SUCCESS_STATES)})`,
    ];
    if (query.email !== null) conditions.push(Prisma.sql`purchases.email = ${query.email}`);
    if (query.productId !== null) conditions.push(Prisma.sql`purchases.link_id = ${query.productId}`);
    if (query.after !== null) conditions.push(Prisma.sql`purchases.created_at >= ${query.after}`);
    if (query.before !== null) conditions.push(Prisma.sql`purchases.created_at < ${query.before}`);
    if (query.payment !== null)
      conditions.push(
        query.payment === "paid" ? Prisma.sql`purchases.price_cents > 0` : Prisma.sql`purchases.price_cents = 0`,
      );
    if (query.kind !== null) {
      const membership = Prisma.sql`purchases.subscription_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.id = purchases.subscription_id AND subscriptions.flags & ${String(SubscriptionFlags.bit("is_installment_plan"))} != 0)`;
      conditions.push(query.kind === "subscription" ? membership : Prisma.sql`NOT (${membership})`);
    }
    if (query.cursor !== null)
      conditions.push(
        Prisma.sql`(purchases.created_at < ${query.cursor.at} OR (purchases.created_at = ${query.cursor.at} AND purchases.id < ${query.cursor.id}))`,
      );
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT purchases.id AS id, purchases.email AS email,
        purchases.link_id AS link_id, links.name AS product_name, purchases.price_cents AS price_cents,
        purchases.fee_cents AS fee_cents, purchases.affiliate_credit_cents AS affiliate_credit_cents,
        purchases.created_at AS created_at, purchases.stripe_refunded AS stripe_refunded,
        purchases.chargeback_date AS chargeback_date, purchases.subscription_id AS subscription_id,
        subscriptions.flags AS subscription_flags, purchases.country AS country, purchases.ip_country AS ip_country,
        offer_codes.code AS offer_code, purchases.referrer AS referrer,
        (SELECT COUNT(*) FROM utm_link_driven_sales counted WHERE counted.purchase_id = purchases.id) AS utm_driven_count,
        utm_links.utm_source AS utm_source, utm_links.utm_medium AS utm_medium, utm_links.utm_campaign AS utm_campaign,
        utm_links.utm_term AS utm_term, utm_links.utm_content AS utm_content
      FROM purchases
      LEFT JOIN links ON links.id = purchases.link_id
      LEFT JOIN offer_codes ON offer_codes.id = purchases.offer_code_id
      LEFT JOIN subscriptions ON subscriptions.id = purchases.subscription_id
      LEFT JOIN utm_link_driven_sales ON utm_link_driven_sales.purchase_id = purchases.id
      LEFT JOIN utm_links ON utm_links.id = utm_link_driven_sales.utm_link_id
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY purchases.created_at DESC, purchases.id DESC LIMIT ${query.limit}`;
    return rows.map((row) => ({
      ...(row as unknown as SaleRow),
      id: BigInt(row.id as bigint),
      link_id: row.link_id === null ? null : BigInt(row.link_id as bigint),
      subscription_id: row.subscription_id === null ? null : BigInt(row.subscription_id as bigint),
      subscription_flags: row.subscription_flags === null ? null : BigInt(row.subscription_flags as bigint),
      stripe_refunded: Boolean(row.stripe_refunded),
      utm_driven_count: num(row.utm_driven_count),
    }));
  },
};

// Purchase::ALL_SUCCESS_STATES
const LIBRARY_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
];

export const readLibrary: LibraryReader = {
  async list(query) {
    const conditions = [
      Prisma.sql`purchases.purchaser_id = ${query.buyerId}`,
      Prisma.sql`purchases.purchase_state IN (${Prisma.join(LIBRARY_STATES)})`,
      // not_is_gift_sender_purchase and not_recurring_charge
      flagSql("is_gift_sender_purchase", false),
      Prisma.sql`(purchases.subscription_id IS NULL OR ${flagSql("is_original_subscription_purchase", true)} OR ${flagSql("is_gift_receiver_purchase", true)})`,
      Prisma.sql`purchases.link_id IS NOT NULL`,
    ];
    if (query.cursor !== null)
      conditions.push(
        Prisma.sql`(purchases.created_at < ${query.cursor.at} OR (purchases.created_at = ${query.cursor.at} AND purchases.id < ${query.cursor.id}))`,
      );
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT purchases.id AS id, purchases.link_id AS link_id,
        links.id IS NOT NULL AS product_exists, links.name AS product_name, links.unique_permalink AS product_permalink,
        sellers.id AS seller_id, sellers.name AS seller_name, sellers.username AS seller_username,
        purchases.displayed_price_cents AS displayed_price_cents,
        purchases.displayed_price_currency_type AS displayed_price_currency_type,
        purchases.created_at AS created_at, purchases.stripe_refunded AS stripe_refunded
      FROM purchases
      LEFT JOIN links ON links.id = purchases.link_id
      LEFT JOIN users sellers ON sellers.id = purchases.seller_id
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY purchases.created_at DESC, purchases.id DESC LIMIT ${query.limit}`;
    return rows.map((row) => ({
      ...(row as unknown as LibraryPurchaseRow),
      id: BigInt(row.id as bigint),
      link_id: BigInt(row.link_id as bigint),
      product_exists: Boolean(row.product_exists),
      seller_id: row.seller_id === null ? null : BigInt(row.seller_id as bigint),
      stripe_refunded: Boolean(row.stripe_refunded),
    }));
  },
};

type CalendarDate = { year: number; month: number; day: number };

// Date.iso8601 for YYYY-MM-DD, YYYYMMDD and YYYY-MM-DDThh:mm[:ss][Z|+hh:mm], where Ruby reads the date and ignores the time. A
// string Ruby may still parse in another ISO 8601 form (week, ordinal, a two-digit year) is Rails's to read; a well-formed
// date that is not on the calendar is the tool's own error.
const DATE_ARGUMENT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$|^(\d{4})(\d{2})(\d{2})$/iu;

function parseDate(value: string, name: string): CalendarDate {
  const match = DATE_ARGUMENT.exec(value);
  if (match === null) throw new HandBackToRails("an MCP date argument that is not YYYY-MM-DD");
  const [year, month, day] = match[1] === undefined ? match.slice(4, 7) : match.slice(1, 4);
  const date = { year: Number(year), month: Number(month), day: Number(day) };
  if (date.year < 1 || date.year > MAX_SUPPORTED_YEAR)
    throw new HandBackToRails("an MCP date argument outside the supported years");
  const roundTrip = fromMs(dateMs(date));
  if (roundTrip.month !== date.month || roundTrip.day !== date.day)
    throw new ToolRpcError(`${name} must be a date like 2026-10-31`, INVALID_PARAMS);
  return date;
}

function dateMs({ year, month, day }: CalendarDate): number {
  const value = new Date(Date.UTC(2000, month - 1, day));
  value.setUTCFullYear(year);
  return value.getTime();
}
function fromMs(ms: number): CalendarDate {
  const value = new Date(ms);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}
const isoDate = ({ year, month, day }: CalendarDate): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// A YYYY-MM-DD bound is a day in the seller's zone: its first instant, as a UTC datetime.
function dayStartUtc(zone: string, date: CalendarDate): string {
  try {
    return utc(new Date(startOfDayIso8601(zone, date.year, date.month, date.day)));
  } catch (error) {
    if (error instanceof InvalidTimeZoneError)
      throw new HandBackToRails("an MCP tool for a seller with an unknown time zone");
    throw error;
  }
}

// Ruby's `present?` on a string.
const isPresent = (value: unknown): value is string => typeof value === "string" && !/^\s*$/u.test(value);

// tool_get_customers
async function getCustomers(args: Hash, context: ToolContext): Promise<Hash> {
  const by = "breakdown" in args ? args.breakdown : "spend";
  const limit = limitFor(args, CUSTOMERS_DEFAULT_ROWS);
  const start = isPresent(args.start_date) ? parseDate(args.start_date, "start_date") : null;
  const end = isPresent(args.end_date) ? parseDate(args.end_date, "end_date") : null;
  if (start !== null && end !== null && dateMs(start) > dateMs(end))
    throw new ToolRpcError("start_date must not be after end_date", INVALID_PARAMS);

  const zone = context.user.timezone;
  const query: CustomerQuery = {
    sellerId: BigInt(context.user.id),
    email: isPresent(args.email) ? args.email.replace(/^[ \t\n\v\f\r\0]+|[ \t\n\v\f\r\0]+$/gu, "") : null,
    from: start === null ? null : dayStartUtc(zone, start),
    // The end date is inclusive: the bound is the first instant of the next local day.
    until: end === null ? null : dayStartUtc(zone, fromMs(dateMs(end) + DAY_MS)),
    limit,
  };
  const readers = context.customers ?? readCustomers;
  let rows: Hash[];
  try {
    if (by === "conversion") {
      rows = (await readers.conversion(query)).map((row) => {
        const days = rubyRoundHalfUp((row.converted_at.getTime() - row.free_at.getTime()) / DAY_MS, 1);
        return {
          email: row.email,
          free_at: iso8601(row.free_at),
          converted_at: iso8601(row.converted_at),
          days_to_convert: new FloatValue(days),
        };
      });
    } else {
      rows = (await readers.spend(query)).map((row) => ({
        email: row.email,
        orders_count: row.orders,
        total_spend_cents: row.spend_cents,
        refunded_cents: row.refunded_cents,
        chargedback_cents: row.chargedback_cents,
        first_order_at: row.first_at === null ? null : iso8601(row.first_at),
        last_order_at: row.last_at === null ? null : iso8601(row.last_at),
      }));
    }
  } catch (error) {
    // Rails words its own error for a query that outlives WithMaxExecutionTime.
    if (String((error as Error).message).includes("maximum statement execution time exceeded"))
      throw new HandBackToRails("a customers query that ran out of time");
    throw error;
  }
  return {
    breakdown: by,
    currency: USD,
    time_zone: zone,
    start_date: start === null ? null : isoDate(start),
    end_date: end === null ? null : isoDate(end),
    rows,
  };
}

const salesMetrics = (revenue: number, units: number) => ({
  revenue_cents: revenue,
  units,
  average_order_value_cents: units > 0 ? Math.round(revenue / units) : null,
});

const TRANSITION_SCAN_MS = 6 * 3_600_000;

// Mcp::Server#local_offset_segments: the range cut at each change of the zone's UTC offset. A transition is found by
// scanning for a change of offset and bisecting to the second.
function offsetSegments(zone: string, startMs: number, endMs: number): OffsetSegment[] {
  const cuts = [startMs];
  for (let at = startMs; at < endMs; at += TRANSITION_SCAN_MS) {
    const next = Math.min(at + TRANSITION_SCAN_MS, endMs);
    if (utcOffsetAt(zone, at) === utcOffsetAt(zone, next)) continue;
    let low = at;
    let high = next;
    while (high - low > 1000) {
      const mid = low + Math.floor((high - low) / 2000) * 1000;
      if (utcOffsetAt(zone, mid) === utcOffsetAt(zone, low)) low = mid;
      else high = mid;
    }
    if (high < endMs) cuts.push(high);
  }
  cuts.push(endMs);
  return cuts.slice(0, -1).map((from, index) => ({
    from: utc(new Date(from)),
    until: utc(new Date(cuts[index + 1]!)),
    offsetSeconds: utcOffsetAt(zone, from),
  }));
}

// tool_get_sales_totals
async function getSalesTotals(args: Hash, context: ToolContext): Promise<Hash> {
  const zone = context.user.timezone;
  const breakdown = "breakdown" in args ? args.breakdown : "product";
  let today: CalendarDate;
  try {
    today = parseDate(instantInTimeZoneIso8601(zone, (context.now ?? (() => new Date()))()).slice(0, 10), "today");
  } catch (error) {
    if (error instanceof InvalidTimeZoneError)
      throw new HandBackToRails("an MCP tool for a seller with an unknown time zone");
    throw error;
  }
  // Unlike get_customers, "" is not absent here: Ruby reads it as a date and fails.
  const end = typeof args.end_date === "string" ? parseDate(args.end_date, "end_date") : today;
  const start =
    typeof args.start_date === "string"
      ? parseDate(args.start_date, "start_date")
      : fromMs(dateMs(end) - (TOTALS_DEFAULT_DAYS - 1) * DAY_MS);
  const days = (dateMs(end) - dateMs(start)) / DAY_MS;
  if (days < 0) throw new ToolRpcError("start_date must not be after end_date", INVALID_PARAMS);
  if (days >= TOTALS_MAX_DAYS)
    throw new ToolRpcError(`The date range cannot exceed ${TOTALS_MAX_DAYS} days`, INVALID_PARAMS);

  const readers = context.salesTotals ?? readSalesTotals;
  const sellerId = BigInt(context.user.id);
  let productId: bigint | null = null;
  if (isPresent(args.product_id)) {
    productId = await readers.findProductId(sellerId, args.product_id);
    if (productId === null) throw new ToolError("The product was not found.");
  }
  const from = dayStartUtc(zone, start);
  const until = dayStartUtc(zone, fromMs(dateMs(end) + DAY_MS));
  const base = { start_date: isoDate(start), end_date: isoDate(end), time_zone: zone, currency: USD, breakdown };

  if (breakdown === "country") {
    const grouped = new Map<string | null, [number, number]>();
    for (const row of await readers.byCountry({ sellerId, productId, from, until })) {
      const named = row.country === null ? null : findByName(row.country);
      // A spelling the country list does not know stays as written, and MySQL's collation picks which spelling a group carries.
      if (row.country !== null && named === null)
        throw new HandBackToRails("a sales totals country that is not in the country list");
      const key = named === null ? null : named.common_name;
      const bucket = grouped.get(key) ?? [0, 0];
      grouped.set(key, [bucket[0] + row.revenue_cents, bucket[1] + row.units]);
    }
    const entries = [...grouped];
    const revenues = entries.map(([, [revenue]]) => revenue);
    // Ruby's sort_by is not stable: rows with equal revenue come out in an order this port cannot promise.
    if (new Set(revenues).size !== revenues.length)
      throw new HandBackToRails("a sales totals by country with equal revenue rows");
    const rows = entries
      .map(([country, [revenue, units]]) => ({ country, ...salesMetrics(revenue, units) }))
      .sort((a, b) => b.revenue_cents - a.revenue_cents)
      .slice(0, TOTALS_MAX_ROWS);
    return { ...base, totals: totalsOf(grouped.values()), rows };
  }

  if (breakdown === "day" || breakdown === "week" || breakdown === "month") {
    let segments: OffsetSegment[];
    try {
      segments = offsetSegments(
        zone,
        Date.parse(`${from.replace(" ", "T")}Z`),
        Date.parse(`${until.replace(" ", "T")}Z`),
      );
    } catch (error) {
      if (error instanceof InvalidTimeZoneError)
        throw new HandBackToRails("an MCP tool for a seller with an unknown time zone");
      throw error;
    }
    const grouped = new Map<string, [number, number]>();
    for (const row of await readers.byPeriod({ sellerId, productId, segments, period: breakdown })) {
      const bucket = grouped.get(row.key) ?? [0, 0];
      grouped.set(row.key, [bucket[0] + row.revenue_cents, bucket[1] + row.units]);
    }
    const rows = [...grouped]
      .map(([date, [revenue, units]]) => ({ date, ...salesMetrics(revenue, units) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { ...base, totals: totalsOf(grouped.values()), rows };
  }

  const rows = await readers.byProduct({ sellerId, productId, from, until });
  const top = rows.toSorted((a, b) => b.revenue_cents - a.revenue_cents).slice(0, TOTALS_MAX_ROWS);
  const names = await readers.productNames(top.map((row) => row.link_id));
  return {
    ...base,
    totals: totalsOf(rows.map((row) => [row.revenue_cents, row.units] as [number, number])),
    rows: top.map((row) => ({
      product_id: encrypt(row.link_id),
      product_name: names.get(row.link_id) ?? null,
      ...salesMetrics(row.revenue_cents, row.units),
    })),
  };
}

function totalsOf(buckets: Iterable<[number, number]>) {
  let revenue = 0;
  let units = 0;
  for (const [r, u] of buckets) {
    revenue += r;
    units += u;
  }
  return salesMetrics(revenue, units);
}

// The columns product_payload reads. Product::Prices#price_cents reads the default Price row, not the column.
const BUY_PRICES = Prisma.sql`FROM prices WHERE prices.link_id = links.id AND prices.deleted_at IS NULL
        AND prices.currency = links.price_currency_type AND COALESCE(prices.flags & 1, 0) = 0`;
const PRODUCT_COLUMNS = Prisma.sql`id, created_at, name,
        (SELECT COUNT(*) ${BUY_PRICES}) AS buy_price_count,
        (SELECT prices.price_cents ${BUY_PRICES} ORDER BY prices.id DESC LIMIT 1) AS buy_price_cents,
        purchase_type, price_currency_type, customizable_price, suggested_price_cents, purchase_disabled_at, draft, flags,
        unique_permalink, custom_permalink`;

function productRow(row: Record<string, unknown>): ProductListRow {
  return {
    ...(row as unknown as ProductListRow),
    id: BigInt(row.id as bigint),
    flags: row.flags === null ? null : BigInt(row.flags as bigint),
    buy_price_count: num(row.buy_price_count),
    customizable_price: row.customizable_price === null ? null : Boolean(row.customizable_price),
    draft: row.draft === null ? null : Boolean(row.draft),
  };
}

export const readProducts: ProductsReader = {
  async list(userId, limit, after) {
    const cursor =
      after === null
        ? Prisma.empty
        : Prisma.sql`AND (links.created_at < ${after.at} OR (links.created_at = ${after.at} AND links.id < ${after.id}))`;
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${PRODUCT_COLUMNS}
      FROM links WHERE user_id = ${userId} AND deleted_at IS NULL ${cursor}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return rows.map(productRow);
  },
  async find(userId, id) {
    const productId = await findSellerProductId(userId, id);
    if (productId === null) return null;
    const [row] = await db.$queryRaw<Record<string, unknown>[]>`SELECT ${PRODUCT_COLUMNS}, description
      FROM links WHERE id = ${productId} LIMIT 1`;
    return row === undefined ? null : { ...productRow(row), description: row.description as string | null };
  },
  files: (productId) =>
    db.productFile.findMany({
      where: { link_id: productId, deleted_at: null },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, display_name: true, url: true, filetype: true, size: true, position: true },
    }),
  async covers(productId) {
    const rows = await db.assetPreview.findMany({
      where: { link_id: productId, deleted_at: null },
      orderBy: [{ position: "asc" }, { created_at: "asc" }, { id: "asc" }],
      select: { guid: true, unsplash_url: true, oembed: true },
    });
    return rows.map((row) => ({ guid: row.guid, unsplash_url: row.unsplash_url, has_oembed: row.oembed !== null }));
  },
};

const IS_RECURRING_BILLING_BIT = 2n;
const IS_LICENSED_BIT = 7n;
const IS_TIERED_MEMBERSHIP_BIT = 19n;
const BUY_ONLY = 0;
const IS_BUNDLE_BIT = 26n;
const flagOn = (flags: bigint | null, position: bigint) => (((flags ?? 0n) >> (position - 1n)) & 1n) === 1n;

// product_payload, for products that are not tiered memberships. A tier carries its own prices, recurrences and closing
// rules (pricing_payload), which are Rails's to read.
function productPayload(product: ProductListRow, user: User, tool: string): Hash {
  if (flagOn(product.flags, IS_TIERED_MEMBERSHIP_BIT)) throw new HandBackToRails(`a tiered membership in ${tool}`);
  // Rentals, recurring prices and several competing buy prices pick their default price by rules Rails owns.
  if (
    product.purchase_type !== BUY_ONLY ||
    flagOn(product.flags, IS_RECURRING_BILLING_BIT) ||
    product.buy_price_count > 1
  )
    throw new HandBackToRails(`a product in ${tool} whose default price is not a single buy price`);
  const payWhatYouWant = product.customizable_price === true;
  return {
    id: encrypt(product.id),
    name: product.name,
    price_cents: product.buy_price_cents,
    currency: product.price_currency_type,
    pay_what_you_want: payWhatYouWant,
    suggested_price_cents: payWhatYouWant ? product.suggested_price_cents : null,
    published: product.purchase_disabled_at === null && product.draft !== true,
    is_bundle: flagOn(product.flags, IS_BUNDLE_BIT),
    url: longUrl(product as unknown as LinkRow, user as unknown as UserRow),
    permalink: product.unique_permalink,
  };
}

// tool_list_products
async function listProducts(args: Hash, context: ToolContext): Promise<Hash> {
  const limit = limitFor(args, 25);
  const rows = await (context.products ?? readProducts).list(BigInt(context.user.id), limit + 1, parseCursor(args));
  const page = rows.slice(0, limit);
  const products = page.map((product) => productPayload(product, context.user, "list_products"));
  const last = page[page.length - 1];
  return {
    products,
    ...(rows.length > limit && last !== undefined
      ? { next_cursor: `${BigInt(last.created_at.getTime()) * 1000n}_${last.id}` }
      : {}),
  };
}

// Mcp::Server#find_product!
async function findProduct(args: Hash, context: ToolContext): Promise<ProductDetailRow> {
  const id = args.id;
  if (id === undefined || id === null || (typeof id === "string" && id.trim() === ""))
    throw new ToolRpcError("id is required", INVALID_PARAMS);
  // An id that is not text is a type the argument check owns.
  if (typeof id !== "string") throw new HandBackToRails("a product id that is not text");
  const product = await (context.products ?? readProducts).find(BigInt(context.user.id), id);
  if (product === null) throw new ToolError("The product was not found.");
  return product;
}

// Mcp::Server#covers_payload, for covers that are Unsplash photos (their url is a column). An uploaded image or video is an
// Active Storage blob whose url Rails signs, and an oembed has its own url.
function coversPayload(covers: CoverRow[]): Hash[] {
  return covers.map((cover) => {
    if (cover.has_oembed || cover.unsplash_url === null || cover.unsplash_url.trim() === "")
      throw new HandBackToRails("a product cover that is not an Unsplash photo");
    return { id: cover.guid, url: cover.unsplash_url, type: "unsplash" };
  });
}

// Object#present? for the values json_data holds.
const isPresent_ = (value: unknown) =>
  typeof value === "string" ? !isBlankText(value) : value !== null && value !== undefined && value !== false;

// json_data is a serialized hash; a value that is not one reads as empty, as `json_data.to_h` would for nil.
function jsonDataOf(raw: unknown): Hash {
  if (typeof raw !== "string" || raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Hash) : {};
}

// Mcp::Server#taxonomy_paths: every taxonomy's slug path walked from parent_id, keyed by the lowercased path (a later row with the same
// path replaces an earlier one), with the label the editor shows for the slug.
type TaxonomyEntry = { id: bigint; path: string; label: string };
async function taxonomyEntries(): Promise<TaxonomyEntry[]> {
  const rows = await db.taxonomy.findMany({
    select: { id: true, parent_id: true, slug: true },
    orderBy: { id: "asc" },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pathOf = (id: bigint, seen: bigint[]): string => {
    if (seen.includes(id)) throw new HandBackToRails("a taxonomy that is its own ancestor");
    const row = byId.get(id)!;
    const parent = row.parent_id === null ? undefined : byId.get(row.parent_id);
    return parent === undefined ? row.slug : `${pathOf(parent.id, [...seen, id])}/${row.slug}`;
  };
  return rows.map((row) => {
    const label = taxonomyLabelOrNull(row.slug);
    return {
      id: row.id,
      path: pathOf(row.id, []).toLowerCase(),
      label: label !== null && label !== "" ? label : row.slug,
    };
  });
}

// Mcp::Server#category_payload
async function categoryOf(taxonomyId: bigint | null): Promise<ProductExtras["category"]> {
  if (taxonomyId === null) return null;
  const entries = await taxonomyEntries();
  const target = entries.find((entry) => entry.id === taxonomyId);
  return target === undefined ? null : { path: target.path, label: target.label };
}

// Ruby's String#<=> compares bytes.
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// tool_list_categories
async function listCategories(): Promise<Hash> {
  const byPath = new Map<string, TaxonomyEntry>();
  for (const entry of await taxonomyEntries()) byPath.set(entry.path, entry);
  const categories = [...byPath.values()]
    .sort((a, b) => byteCompare(a.path, b.path))
    .map((entry) => ({ path: entry.path, label: entry.label }));
  return { categories };
}

export const readProductExtras: NonNullable<ToolContext["productExtras"]> = async (productId) => {
  const row = await db.link.findUniqueOrThrow({
    where: { id: productId },
    select: { taxonomy_id: true, json_data: true },
  });
  const jsonData = jsonDataOf(row.json_data);
  const rawDetails = jsonData.custom_attributes;
  const details: unknown[] = Array.isArray(rawDetails) ? rawDetails : [];
  const additional_details = details.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new HandBackToRails("an additional detail that is not a name and value pair");
    const { name, value } = entry as Hash;
    return isPresent_(name) || isPresent_(value) ? [{ name: name ?? null, value: value ?? null }] : [];
  });
  // `product.tags` has no ORDER BY, so more than one tag comes back in an order the port cannot see.
  const tags = await db.productTagging.findMany({ where: { product_id: Number(productId) } });
  if (tags.length > 1) throw new HandBackToRails("a product with several tags");
  const names =
    tags.length === 0
      ? []
      : (await db.tag.findMany({ where: { id: { in: tags.map((tag) => tag.tag_id!) } } })).map((tag) => tag.name);
  return {
    category: await categoryOf(row.taxonomy_id),
    summary: jsonData.custom_summary ?? null,
    additional_details,
    tags: names,
    // attr_json_data_accessor reads a blank value as nil; custom_summary is read raw.
    custom_receipt_text: isBlank(jsonData.custom_receipt_text) ? null : jsonData.custom_receipt_text,
    custom_view_content_button_text: isBlank(jsonData.custom_view_content_button_text)
      ? null
      : jsonData.custom_view_content_button_text,
  };
};

// Mcp::Server#bundle_products_payload: `bundle_products.alive.in_order`, which leaves rows that share a position (or have none) in no
// defined order.
export const readBundleProducts: NonNullable<ToolContext["bundleProducts"]> = async (bundleId) => {
  const rows = await db.bundleProduct.findMany({
    where: { bundle_id: bundleId, deleted_at: null },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const positions = rows.map((row) => row.position);
  if (positions.some((position) => position === null) || new Set(positions).size !== positions.length)
    throw new HandBackToRails("bundle products that share a position");
  const products = await db.link.findMany({
    where: { id: { in: rows.map((row) => row.product_id) } },
    select: { id: true, name: true },
  });
  const names = new Map(products.map((product) => [product.id, product.name]));
  return rows.map((row) => {
    if (!names.has(row.product_id)) throw new HandBackToRails("a bundle product whose product is missing");
    return {
      id: encrypt(row.product_id),
      name: names.get(row.product_id) ?? null,
      variant_id: row.variant_id === null ? null : encrypt(row.variant_id),
      quantity: row.quantity,
    };
  });
};

// A Ruby Float in a payload. JSON.generate prints `1500.0` where JSON.stringify prints `1500`, and the text of a tool result
// is that output verbatim.
export class FloatValue {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
}

// JSON.pretty_generate of a payload, with each FloatValue spelled as Float#to_s.
export function toolText(payload: Hash): string {
  const marker = `float:${Math.random().toString(36).slice(2)}:`;
  const text = JSON.stringify(
    payload,
    function (this: Record<string, unknown>, key: string, value: unknown) {
      const original = this[key];
      return original instanceof FloatValue ? `${marker}${rubyFloatToS(original.value)}` : value;
    },
    2,
  );
  return text.replace(new RegExp(`"${marker}([^"]+)"`, "gu"), "$1");
}

export const productStats: NonNullable<ToolContext["productStats"]> = async (productId) => {
  const target = { id: productId } as Parameters<typeof successfulSalesCount>[0];
  return {
    sales_count: await successfulSalesCount(target),
    sales_usd_cents: new FloatValue(await totalUsdCents(target)),
  };
};

// tool_get_product
async function getProduct(args: Hash, context: ToolContext): Promise<Hash> {
  const product = await findProduct(args, context);
  const payload = productPayload(product, context.user, "get_product");
  const extras = await (context.productExtras ?? readProductExtras)(product.id);
  const details: Hash = {
    category: extras.category,
    description: product.description,
    summary: extras.summary,
    additional_details: extras.additional_details,
    tags: extras.tags,
    custom_receipt_text: extras.custom_receipt_text,
    custom_view_content_button_text: extras.custom_view_content_button_text,
    covers: coversPayload(await (context.products ?? readProducts).covers(product.id)),
  };
  // A bundle also lists the members it has now (BundleProduct#in_order).
  if (flagOn(product.flags, IS_BUNDLE_BIT))
    details.bundle_products = await (context.bundleProducts ?? readBundleProducts)(product.id);
  const held = (context.token.scopes ?? "").split(/\s+/u);
  // The same rule as the public API: sales figures need a sales scope.
  if (held.includes("view_sales") || held.includes("account"))
    Object.assign(details, await (context.productStats ?? productStats)(product.id));
  return { product: { ...payload, ...details } };
}

// tool_list_files
async function listFiles(args: Hash, context: ToolContext): Promise<Hash> {
  const product = await findProduct(args, context);
  const payload = productPayload(product, context.user, "list_files");
  const rows = await (context.products ?? readProducts).files(product.id);
  // `in_order` is `ORDER BY position ASC`: rows that share a position (or have none) come back in no defined order.
  const positions = rows.map((row) => row.position);
  if (new Set(positions).size !== positions.length) throw new HandBackToRails("product files that share a position");
  const owner = context.user.external_id;
  const files = rows.map((row) => {
    const file = row as unknown as ProductFile;
    const fields = s3Fields(row.url, owner);
    return {
      id: encrypt(row.id),
      name: nameDisplayable(file, fields),
      type: displayExtension(file, fields),
      size_bytes: row.size === null ? 0 : Number(row.size),
      position: row.position,
    };
  });
  return { product: payload, files };
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?)?$/u;

// Mcp::Server#parse_time! (Time.zone.parse in UTC) for the two forms an agent sends: a date, or a whole-second ISO 8601
// time. Any other spelling Ruby's parser might accept is Rails's to read. Returns a UTC datetime.
function parseTimeArgument(value: string): string {
  const match = ISO_TIME.exec(value);
  if (match === null)
    throw new HandBackToRails("an MCP time argument that is not YYYY-MM-DD or a whole-second ISO 8601 time");
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const zone = match[7];
  const instant = new Date(Date.UTC(2000, month! - 1, day, hour, minute, second));
  instant.setUTCFullYear(year!);
  const valid =
    year! >= 1000 &&
    year! <= MAX_SUPPORTED_YEAR &&
    month! >= 1 &&
    month! <= 12 &&
    instant.getUTCMonth() === month! - 1 &&
    instant.getUTCDate() === day! &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60;
  if (!valid) throw new HandBackToRails("an MCP time argument that is not a valid calendar time");
  let ms = instant.getTime();
  if (zone !== undefined && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    ms -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
  }
  const shifted = new Date(ms);
  if (shifted.getUTCFullYear() < 1000 || shifted.getUTCFullYear() > MAX_SUPPORTED_YEAR)
    throw new HandBackToRails("an MCP time argument outside the supported years");
  return utc(shifted);
}

// tool_list_sales and sale_payload, with `paginate` over (created_at, id).
async function listSales(args: Hash, context: ToolContext): Promise<Hash> {
  const readers = context.sales ?? readSales;
  const sellerId = BigInt(context.user.id);
  const email = isPresent(args.email) ? args.email.replace(/^[ \t\n\v\f\r\0]+|[ \t\n\v\f\r\0]+$/gu, "") : null;
  let productId: bigint | null = null;
  if (isPresent(args.product_id)) {
    productId = await readers.findProductId(sellerId, args.product_id);
    if (productId === null) throw new ToolError("The product was not found.");
  }
  const after = isPresent(args.after) ? parseTimeArgument(args.after) : null;
  const before = isPresent(args.before) ? parseTimeArgument(args.before) : null;
  const limit = limitFor(args, 25);
  const cursor = parseCursor(args);
  const rows = await readers.list({
    sellerId,
    email,
    productId,
    after,
    before,
    // Ruby tests `args["payment"]` for truthiness, so an empty string would count as free; the schema enum rules it out.
    payment: "payment" in args ? (args.payment === "paid" ? "paid" : "free") : null,
    kind: "kind" in args ? (args.kind === "subscription" ? "subscription" : "one_time") : null,
    cursor,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const seen = new Set<bigint>();
  const sales = page.map((sale) => {
    // The sale's UTM link comes from its first driven-sale row; a purchase with several has no single answer here.
    if (sale.utm_driven_count > 1 || sale.link_id === null || sale.price_cents === null || seen.has(sale.id))
      throw new HandBackToRails("a sale that has several UTM links, no product or no price");
    seen.add(sale.id);
    const fee = sale.fee_cents ?? 0;
    const affiliate = sale.affiliate_credit_cents ?? 0;
    const country = isPresent(sale.country) ? sale.country : sale.ip_country;
    return {
      id: encrypt(sale.id),
      email: sale.email,
      product_id: encrypt(sale.link_id),
      product_name: sale.product_name,
      price_cents: sale.price_cents,
      fee_cents: fee,
      affiliate_commission_cents: affiliate,
      net_cents: sale.price_cents - fee - affiliate,
      currency: USD,
      created_at: iso8601(sale.created_at),
      refunded: sale.stripe_refunded,
      chargedback: sale.chargeback_date !== null,
      subscription:
        sale.subscription_id !== null &&
        ((sale.subscription_flags ?? 0n) & BigInt(SubscriptionFlags.bit("is_installment_plan"))) === 0n,
      country,
      discount_code: sale.offer_code,
      referrer: isPresent(sale.referrer) ? sale.referrer : null,
      utm_source: sale.utm_source,
      utm_medium: sale.utm_medium,
      utm_campaign: sale.utm_campaign,
      utm_term: sale.utm_term,
      utm_content: sale.utm_content,
    };
  });
  const last = page[page.length - 1];
  return {
    sales,
    ...(rows.length > limit && last !== undefined
      ? { next_cursor: `${BigInt(last.created_at.getTime()) * 1000n}_${last.id}` }
      : {}),
  };
}

// tool_list_purchases: the buyer's own successful purchases, one row per purchase, with `paginate` over (created_at, id). The
// limit counts rows whose product row is gone, and Ruby drops them after paging.
async function listPurchases(args: Hash, context: ToolContext): Promise<Hash> {
  const limit = limitFor(args, 25);
  const cursor = parseCursor(args);
  const rows = await (context.library ?? readLibrary).list({
    buyerId: BigInt(context.user.id),
    cursor,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const { protocol, domain } = domainConfig(process.env);
  const purchases: Hash[] = [];
  for (const row of page) {
    if (!row.product_exists) continue;
    // Rails raises on a purchase without a seller or a stored price; User#display_name falls back to the email.
    if (row.seller_id === null || row.displayed_price_cents === null || row.displayed_price_currency_type === null)
      throw new HandBackToRails("a library purchase without a seller, a displayed price or a currency");
    if (!isPresent(row.seller_name) && !isPresent(row.seller_username))
      throw new HandBackToRails("a library purchase whose seller has no name or username");
    purchases.push({
      id: encrypt(row.id),
      product_name: row.product_name,
      product_permalink: row.product_permalink,
      seller_name: isPresent(row.seller_name) ? row.seller_name : row.seller_username,
      price_cents: row.displayed_price_cents,
      currency: row.displayed_price_currency_type,
      purchased_at: iso8601(row.created_at),
      refunded: row.stripe_refunded,
      url: `${protocol}://${domain}/library`,
    });
  }
  const last = page[page.length - 1];
  return {
    purchases,
    ...(rows.length > limit && last !== undefined
      ? { next_cursor: `${BigInt(last.created_at.getTime()) * 1000n}_${last.id}` }
      : {}),
  };
}

// tool_get_account. User#username falls back to the external id, so the storefront URL always has a subdomain.
function getAccount(user: User): Hash {
  const { protocol, rootDomain } = domainConfig(process.env);
  const username = user.username !== null && user.username.trim() !== "" ? user.username : user.external_id!;
  return {
    id: user.external_id,
    name: user.name,
    username,
    url: `${protocol}://${username.replaceAll("_", "-")}.${rootDomain}`,
    currency: user.currency_type,
  };
}

// tool_list_payouts, with `paginate`: one extra row tells whether another page exists.
async function listPayouts(args: Hash, context: ToolContext): Promise<Hash> {
  const limit = limitFor(args, DEFAULT_PAYOUTS);
  const rows = await (context.payouts ?? readPayouts)(BigInt(context.user.id), limit + 1, parseCursor(args));
  const page = rows.slice(0, limit);
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    if (last.created_at === null) throw new HandBackToRails("a payout without a creation time");
    nextCursor = `${BigInt(last.created_at.getTime()) * 1000n}_${last.id}`;
  }
  return {
    payouts: page.map((payout) => ({
      id: encrypt(payout.id),
      amount_cents: payout.amount_cents === null ? null : Number(payout.amount_cents),
      currency: payout.currency,
      state: payout.state,
      created_at: payout.created_at === null ? null : iso8601(payout.created_at),
    })),
    // `.compact` drops the cursor of a last page.
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

// tool_publish_product and tool_unpublish_product. Everything Node cannot follow is refused before the first write, so a
// hand-back never follows one: the payload is built from the product as it stands, then again from the saved row.
async function setPublication(args: Hash, context: ToolContext, publish: boolean): Promise<Hash> {
  const found = await findProduct(args, context);
  const tool = publish ? "publish_product" : "unpublish_product";
  productPayload(found, context.user, tool);
  const product = await db.link.findUniqueOrThrow({ where: { id: found.id } });
  if (publish) {
    // validate_product_price_against_all_offer_codes? checks every code that applies to the product.
    if (await hasApplicableOfferCodes(context.user, product))
      throw new HandBackToRails("a publish of a product with discount codes");
    await assertPlainPublish(product, context.user);
    // Link::LinkInvalid is a tool error in Mcp::Server#call_tool.
    const refused = await publishBang(product, context.user, context.now);
    if (refused !== null) throw new ToolError(refused);
  } else {
    // Link#unpublish!: `self.purchase_disabled_at ||= Time.current; save!`
    const now = (context.now ?? (() => new Date()))();
    await Links.updateBang(
      Links.load(product),
      { purchase_disabled_at: product.purchase_disabled_at ?? now },
      { now: () => now },
    );
  }
  const saved = await (context.products ?? readProducts).find(BigInt(context.user.id), encrypt(found.id));
  return { product: productPayload(saved ?? found, context.user, tool) };
}

// BasePrice::Shared::MAX_PRICE_CENTS
const MAX_PRICE_CENTS = 2_147_483_647;
const PRICE_TOO_LARGE = "Sorry, the price entered is too large.";
// Ruby's String#strip: ASCII whitespace only, where JavaScript's trim() also takes NBSP and the Unicode spaces.
const rubyStrip = (value: string) => value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
const toSentence = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

// BasePrice::Recurrence::ALLOWED_RECURRENCES and Mcp::Server::TIER_KEYS
const ALLOWED_RECURRENCES = ["monthly", "quarterly", "biannually", "yearly", "every_two_years"];
const TIER_KEYS = ["name", "price_cents", "recurrence"];

// Mcp::Server#validated_tiers!, for the arguments it refuses. A valid set of tiers is for the caller to hand back.
function validatedTiers(tiers: unknown): void {
  const refuse = (message: string): never => {
    throw new ToolRpcError(message, INVALID_PARAMS);
  };
  if (!Array.isArray(tiers) || tiers.length === 0) refuse("tiers are required for a membership");
  (tiers as unknown[]).forEach((tier, index) => {
    if (tier === null || typeof tier !== "object" || Array.isArray(tier)) refuse(`tiers[${index}] must be an object`);
    const hash = tier as Hash;
    const unknown = Object.keys(hash).find((key) => !TIER_KEYS.includes(key));
    if (unknown !== undefined) refuse(`tiers[${index}] has unknown argument: ${unknown}`);
    const missing = TIER_KEYS.find((key) => !(key in hash));
    if (missing !== undefined) refuse(`tiers[${index}].${missing} is required`);
    if (typeof hash.name !== "string" || /^[\s\u0085\u180e\u200b-\u200d\u2060\ufeff]*$/u.test(rubyStrip(hash.name)))
      refuse(`tiers[${index}].name must be a non-blank string`);
    const price = hash.price_cents;
    if (typeof price !== "number" || !Number.isInteger(price) || price < 0)
      refuse(`tiers[${index}].price_cents must be an integer of zero or more`);
    if ((price as number) > MAX_PRICE_CENTS) refuse(`tiers[${index}].price_cents must be at most ${MAX_PRICE_CENTS}`);
    if (!ALLOWED_RECURRENCES.includes(hash.recurrence as string))
      refuse(`tiers[${index}].recurrence must be one of: ${ALLOWED_RECURRENCES.join(", ")}`);
  });
  if (new Set((tiers as Hash[]).map((tier) => tier.recurrence)).size > 1)
    refuse("every tier must use the same recurrence");
}

// A tier that sets pay_what_you_want or suggested_price_cents.
const tiersPrice = (tiers: unknown): boolean =>
  Array.isArray(tiers) &&
  tiers.some(
    (tier) =>
      tier !== null &&
      typeof tier === "object" &&
      ("pay_what_you_want" in (tier as Hash) || "suggested_price_cents" in (tier as Hash)),
  );

// tool_create_draft_product for a digital product. Argument errors come before the scope check, so they are answered here and the scope
// is checked after them. A membership, a seller pricing in another currency, and a description with markup other than
// paragraphs go to Rails whole, before the first write.
async function createDraftProduct(args: Hash, context: ToolContext): Promise<Hash> {
  // A currency, a tier price option and a membership's pay what you want are checked and written by Rails, which answers their argument
  // errors ahead of the scope check.
  if ("currency" in args || tiersPrice(args.tiers))
    throw new HandBackToRails("a draft product with a currency or a pay-what-you-want price");
  if (args.product_type === "membership" && ["pay_what_you_want", "suggested_price_cents"].some((key) => key in args))
    throw new HandBackToRails("a draft membership with a pay-what-you-want price");
  if (args.product_type === "membership") {
    if ("price_cents" in args)
      throw new ToolRpcError(
        "price_cents is not accepted for a membership; set each tier's price_cents",
        INVALID_PARAMS,
      );
    validatedTiers(args.tiers);
    throw new HandBackToRails("a draft membership");
  }
  if (!("price_cents" in args)) throw new ToolRpcError("price_cents is required", INVALID_PARAMS);
  if ("tiers" in args) throw new ToolRpcError("tiers are only accepted with product_type membership", INVALID_PARAMS);
  // Rails reads the two arguments as they come; a value that is not a boolean or a whole number goes to it.
  const payWhatYouWant = args.pay_what_you_want;
  const suggested = args.suggested_price_cents;
  if (payWhatYouWant !== undefined && typeof payWhatYouWant !== "boolean")
    throw new HandBackToRails("a pay_what_you_want that is not a boolean");
  if (suggested !== undefined && !Number.isSafeInteger(suggested))
    throw new HandBackToRails("a suggested price that is not a whole number");
  if (suggested !== undefined && payWhatYouWant !== true)
    throw new ToolRpcError("suggested_price_cents needs pay_what_you_want: true in the same call", INVALID_PARAMS);
  await requireScopes(context.token, ["edit_products", "account"]);
  const rawName = args.name as string;
  if (rawName.includes("\0")) throw new HandBackToRails("a name with a NUL character");
  const name = rubyStrip(rawName);
  if (/^[\s\u0085\u180e\u200b-\u200d\u2060\ufeff]*$/u.test(name))
    throw new ToolRpcError("name is required", INVALID_PARAMS);
  const priceCents = args.price_cents as number;
  if (priceCents < 0) throw new ToolRpcError("price_cents must be zero or more", INVALID_PARAMS);
  if (!Number.isSafeInteger(priceCents)) throw new HandBackToRails("a price beyond 2^53");
  const description = "description" in args ? (args.description as string) : "";
  if (/[<>&]/u.test(description) && !PARAGRAPH_DESCRIPTION.test(description))
    throw new HandBackToRails("a description with markup other than paragraphs");
  // CurrencyHelper#query_rate is not ported, so a seller who prices in another currency goes to Rails.
  if (context.user.currency_type !== USD) throw new HandBackToRails("a seller who prices in another currency");
  // Link#price_cents= raises LinkInvalid ahead of the save.
  if (priceCents > MAX_PRICE_CENTS) throw new ToolError(PRICE_TOO_LARGE);

  const user = context.user;
  const seller: CreateSeller = {
    id: user.id,
    flags: user.flags,
    verified: user.verified,
    confirmed_at: user.confirmed_at,
    created_at: user.created_at,
    user_risk_state: user.user_risk_state,
    json_data: user.json_data,
    isTeamMember: UserFlags.isSet(user.flags, "is_team_member"),
  };
  let outcome: Awaited<ReturnType<typeof createApiLink>> | undefined;
  await transaction(async () => {
    outcome = await createApiLink(
      seller,
      {
        name,
        description,
        priceCents,
        currency: USD,
        taxonomyId: null,
        customSummary: null,
        ...(payWhatYouWant !== undefined && { customizablePrice: payWhatYouWant }),
        ...(suggested !== undefined && { suggestedPriceCents: suggested as number }),
      },
      context.now,
    );
  });
  if (!outcome!.created) throw new ToolError(toSentence(outcome!.errors.fullMessages()));
  const saved = await (context.products ?? readProducts).find(
    BigInt(user.id),
    encrypt(outcome!.link.get("id") as bigint),
  );
  if (saved === null) throw new HandBackToRails("a product that was not found after its save");
  return {
    product: productPayload(saved, user, "create_draft_product"),
    message: "Draft saved. It is not for sale until publish_product.",
  };
}

class PermalinkChangedDuringLock extends Error {}
const FORCE_PRODUCT_ID_TIMESTAMP_KEY = "force_product_id_timestamp";

// The two branches of a permalink claim whose callbacks are not ported, found before the first write: a deleted product of the seller
// that holds the slug (it is released with its own save), and a licensed product while a product-id cutover is set.
async function assertPermalinkReleasable(
  product: { id: bigint; user_id: number | bigint | null; flags: bigint },
  permalink: string | null,
): Promise<void> {
  if (permalink === null) return;
  const [deleted] = await selectRows(
    Prisma.sql`SELECT id FROM links WHERE user_id = ${product.user_id} AND deleted_at IS NOT NULL AND custom_permalink = ${permalink} LIMIT 1`,
  );
  if (deleted) throw new HandBackToRails("a permalink a deleted product of the seller holds");
  if (flagOn(product.flags, IS_LICENSED_BIT) && (await getRedis("main").get(FORCE_PRODUCT_ID_TIMESTAMP_KEY)) !== null)
    throw new HandBackToRails("a licensed product's permalink while a product-id cutover is set");
}

// String#blank?: [[:space:]] only. The zero-width characters and U+180E are not space to it.
const isBlankText = (value: string) => isBlank(value);

// tool_update_product for name, description, price_cents and permalink on a product with one buy price. A permalink that a deleted product of
// the seller holds, or that a licensed product claims while a product-id cutover is set, a description Node cannot sanitize like
// SaveContentUpsellsService, a rename of a published product (content moderation), a product beside discount codes (the warning lists the
// ones the new price breaks) and a product whose price is not one buy price go to Rails whole, before the first write.
const UNPORTED_UPDATE_KEYS = ["category", "currency"];

// A lone surrogate is what JSON.dump refuses to write; the port cannot tell which error Rails would raise first.
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const assertWritableText = (text: string) => {
  if (LONE_SURROGATE.test(text)) throw new HandBackToRails("text JSON.dump would not write");
};

// `value.to_s.presence`
const presence = (text: string): string | null => {
  assertWritableText(text);
  return isBlank(text) ? null : text;
};

// Mcp::Server#additional_detail_text: both fields are declared as strings, and nil reads as an empty one.
function additionalDetailText(row: Hash, key: "name" | "value"): string {
  const field = Object.hasOwn(row, key) ? row[key] : null;
  if (field === null || field === undefined) return "";
  if (typeof field !== "string") return rpcError(`additional detail ${key} must be text`);
  assertWritableText(field);
  return field;
}

// Mcp::Server#normalized_additional_details
function normalizedAdditionalDetails(rows: unknown[]): RubyHash[] {
  return rows
    .map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row))
        return rpcError("each additional detail must be an object with name and value");
      const name = additionalDetailText(row as Hash, "name");
      const value = additionalDetailText(row as Hash, "value");
      // The editor keeps a row only when it has a name, so a value on its own is refused.
      if (isBlank(name) && !isBlank(value)) rpcError("each additional detail needs a name");
      return { name, value };
    })
    .filter((row) => !(isBlank(row.name) && isBlank(row.value)))
    .map(
      (row) =>
        new RubyHash([
          ["name", row.name],
          ["value", row.value],
        ]),
    );
}

// The json_data keys update_product writes, in the order tool_update_product assigns them.
function plannedJsonDataWrites(args: Hash): [string, YamlValue][] {
  const writes: [string, YamlValue][] = [];
  if ("summary" in args) writes.push(["custom_summary", presence(args.summary as string)]);
  if ("additional_details" in args)
    writes.push(["custom_attributes", normalizedAdditionalDetails(args.additional_details as unknown[])]);
  if ("custom_receipt_text" in args) writes.push(["custom_receipt_text", presence(args.custom_receipt_text as string)]);
  if ("custom_view_content_button_text" in args)
    writes.push(["custom_view_content_button_text", presence(args.custom_view_content_button_text as string)]);
  return writes;
}

// Mcp::Server::MAX_TAGS, MIN_TAG_LENGTH, MAX_TAG_LENGTH
const MAX_TAGS = 10;
const MIN_TAG_LENGTH = 2;
const MAX_TAG_LENGTH = 20;
// Printable ASCII and the whitespace `[[:space:]]` matches in it: what `downcase.strip.gsub` reads the same in Node.
const ASCII_TAG_TEXT = /^[\t-\r\u0020-\u007e]*$/u;
// A name Tag's own validations and callbacks leave alone, with no space: the tag recordings hold none.
const PLAIN_TAG = /^[a-z0-9](?:[a-z0-9_-])*[a-z0-9]$/u;

type TagPlan = { error: ToolRpcError } | { work: Awaited<ReturnType<typeof planTagChanges>> };

// Mcp::Server#normalized_tags, and the save_tags! work for it. Rails raises its errors only after the product row is saved, so one is
// returned for the transaction to throw; what Node cannot follow (several tags, whose order `product.tags` leaves open, a name the Tag
// model would change or refuse, a list that is not an array) goes to Rails before any write.
async function planTags(productId: bigint, tags: unknown): Promise<TagPlan> {
  if (!Array.isArray(tags)) throw new HandBackToRails("a tag list that is not an array");
  const names: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") return { error: new ToolRpcError("each tag must be text", INVALID_PARAMS) };
    if (!ASCII_TAG_TEXT.test(tag)) throw new HandBackToRails("a tag with text beyond printable ASCII");
    names.push(rubyStrip(tag.toLowerCase()).replace(/[\t-\r ]+/gu, " "));
  }
  const unique = [...new Set(names)];
  if (unique.some((name) => name.length < MIN_TAG_LENGTH || name.length > MAX_TAG_LENGTH))
    return {
      error: new ToolRpcError(`each tag must be ${MIN_TAG_LENGTH}-${MAX_TAG_LENGTH} characters`, INVALID_PARAMS),
    };
  if (
    unique.length > MAX_TAGS &&
    unique.length >= (await db.productTagging.count({ where: { product_id: Number(productId) } }))
  )
    return { error: new ToolRpcError(`a product can have up to ${MAX_TAGS} tags`, INVALID_PARAMS) };
  if (unique.length > 1) throw new HandBackToRails("several tags");
  if (unique.some((name) => !PLAIN_TAG.test(name)))
    throw new HandBackToRails("a tag the Tag model would change or refuse");
  try {
    return { work: await planTagChanges(productId, unique) };
  } catch (caught) {
    if (caught instanceof NotPortedError) throw new HandBackToRails(caught.message);
    throw caught;
  }
}

async function updateProduct(args: Hash, context: ToolContext): Promise<Hash> {
  // The fields Node does not write: category and currency are resolved against Rails' tables.
  if (UNPORTED_UPDATE_KEYS.some((key) => key in args))
    throw new HandBackToRails("an update_product field Node does not write");
  // Rails assigns the two as they come; only a boolean and a whole number are recorded.
  const payWhatYouWant = args.pay_what_you_want;
  const suggested = args.suggested_price_cents;
  if ("pay_what_you_want" in args && typeof payWhatYouWant !== "boolean")
    throw new HandBackToRails("a pay_what_you_want that is not a boolean");
  if ("suggested_price_cents" in args && !Number.isSafeInteger(suggested))
    throw new HandBackToRails("a suggested price that is not a whole number");
  const found = await findProduct(args, context);
  const changes = [
    "name",
    "description",
    "summary",
    "additional_details",
    "price_cents",
    "pay_what_you_want",
    "suggested_price_cents",
    "custom_receipt_text",
    "custom_view_content_button_text",
    "permalink",
    "tags",
  ].filter((key) => key in args);
  if (changes.length === 0)
    throw new ToolRpcError(
      "Pass at least one of name, description, summary, additional_details, category, tags, price_cents, currency, pay_what_you_want, suggested_price_cents, custom_receipt_text, custom_view_content_button_text, or permalink",
      INVALID_PARAMS,
    );
  // An empty permalink is how the editor clears a custom URL; a blank one is neither that nor a value.
  let permalink: string | null | undefined;
  if (changes.includes("permalink")) {
    const given = args.permalink as string;
    if (given === "") permalink = null;
    else if (isBlankText(given))
      throw new ToolRpcError(
        "permalink must not be blank. Send an empty string to go back to the default URL.",
        INVALID_PARAMS,
      );
    else permalink = given;
  }
  // The payload is built from the product as it stands: a tiered membership or a competing price goes to Rails here.
  productPayload(found, context.user, "update_product");
  const product = await db.link.findUniqueOrThrow({ where: { id: found.id } });

  const attributes: Partial<typeof product> = {};
  // Seller row before product row, and only when the slug is a new one: the order the editor and the v2 API lock in.
  const claimsPermalink = permalink != null && permalink !== product.custom_permalink;
  if (permalink !== undefined && permalink !== product.custom_permalink)
    await assertPermalinkReleasable(product, permalink);
  if ("name" in args) {
    const rawName = args.name as string;
    if (rawName.includes("\0")) throw new HandBackToRails("a name with a NUL character");
    const name = rubyStrip(rawName);
    if (isBlankText(name)) throw new ToolRpcError("name must not be blank", INVALID_PARAMS);
    if (name !== product.name && isPublishedProduct(product))
      throw new HandBackToRails("the rename of a published product");
    attributes.name = name;
  }
  let priceCents: number | undefined;
  if ("price_cents" in args) {
    const price = args.price_cents as number;
    if (price < 0) throw new ToolRpcError("price_cents must be zero or more", INVALID_PARAMS);
    if (!Number.isSafeInteger(price)) throw new HandBackToRails("a price beyond 2^53");
    const plan = await planBuyPriceWrite(product, price);
    // Link#price_cents= raises LinkInvalid, which the transaction rolls back.
    if ("tooLarge" in plan) throw new ToolError(PRICE_WRITE_TOO_LARGE);
    priceCents = plan.cents;
  }
  // After the price: the suggested price is validated against the price set in this save.
  if ("pay_what_you_want" in args) attributes.customizable_price = payWhatYouWant as boolean;
  if ("suggested_price_cents" in args) attributes.suggested_price_cents = suggested as number;
  if ("description" in args) attributes.description = plannedDescription(product, args.description);
  const jsonDataWrites = plannedJsonDataWrites(args);
  if (await hasApplicableOfferCodes(context.user, product))
    throw new HandBackToRails("a product beside discount codes");
  const tagPlan = "tags" in args ? await planTags(product.id, args.tags) : undefined;

  const record = Links.load(product);
  try {
    await transaction(async () => {
      // Link#lock_for_permalink_claim!
      if (claimsPermalink)
        await selectRows(Prisma.sql`SELECT id FROM users WHERE id = ${product.user_id} LIMIT 1 FOR UPDATE`);
      await Links.lockBang(record);
      if (permalink != null && !claimsPermalink && permalink !== record.get("custom_permalink"))
        throw new PermalinkChangedDuringLock();
      if (priceCents !== undefined) await writeBuyPrice(product, priceCents, context.now);
      // Checked against the switch the lock reloaded: an amount stored while it is off reads back as no suggested price.
      if ("suggested_price_cents" in args && !(attributes.customizable_price ?? record.get("customizable_price")))
        rpcError("suggested_price_cents needs pay what you want on: pass pay_what_you_want: true in this call");
      if (permalink !== undefined) attributes.custom_permalink = permalink;
      for (const [key, value] of jsonDataWrites) setJsonDataForAttr(record, key, value);
      await Links.updateBang(record, attributes, { now: context.now });
      // After the product row, in the same transaction: a refused tag list rolls the other fields back.
      if (tagPlan !== undefined) {
        if ("error" in tagPlan) throw tagPlan.error;
        await saveTags(product.id, tagPlan.work);
      }
    });
  } catch (caught) {
    if (caught instanceof PermalinkChangedDuringLock)
      throw new ToolError(
        "This product's URL changed while the update was waiting. Nothing was saved; try the update again.",
      );
    if (!(caught instanceof RecordInvalid)) throw caught;
    throw new ToolError(toSentence(record.errors.fullMessages()));
  }
  const saved = await (context.products ?? readProducts).find(BigInt(context.user.id), encrypt(found.id));
  if (saved === null) throw new HandBackToRails("a product that was not found after its save");
  const extras = await (context.productExtras ?? readProductExtras)(saved.id);
  return {
    product: {
      ...productPayload(saved, context.user, "update_product"),
      category: extras.category,
      description: saved.description,
      summary: extras.summary,
      additional_details: extras.additional_details,
      tags: extras.tags,
      custom_receipt_text: extras.custom_receipt_text,
      custom_view_content_button_text: extras.custom_view_content_button_text,
    },
  };
}

// DISCOUNT_PERCENT_RANGE, DISCOUNT_YEAR_RANGE
const DISCOUNT_PERCENT_MIN = 1;
const DISCOUNT_PERCENT_MAX = 100;
const DISCOUNT_YEAR_MIN = 1000;
const DISCOUNT_YEAR_MAX = 9999;
const INTEGER_COLUMN_MAX = 2 ** 31 - 1;
const DISCOUNT_CODE_KEYS = ["percent_off", "amount_cents", "valid_at", "expires_at", "max_purchase_count"];
const rpcError = (message: string): never => {
  throw new ToolRpcError(message, INVALID_PARAMS);
};

// Mcp::Server#discount_amount_attributes: the argument errors, and the kind of amount given.
function discountAmount(
  args: Hash,
  required: boolean,
): { kind: "percent"; percent: number } | { kind: "cents"; cents: number } | undefined {
  const percent = args.percent_off as number | undefined;
  const cents = args.amount_cents as number | undefined;
  if (percent !== undefined && cents !== undefined) rpcError("Pass only one of percent_off or amount_cents");
  if (required && percent === undefined && cents === undefined) rpcError("Pass one of percent_off or amount_cents");
  if (percent !== undefined) {
    if (!(percent >= DISCOUNT_PERCENT_MIN && percent <= DISCOUNT_PERCENT_MAX))
      rpcError(`percent_off must be between ${DISCOUNT_PERCENT_MIN} and ${DISCOUNT_PERCENT_MAX}`);
    return { kind: "percent", percent };
  }
  if (cents !== undefined) {
    if (!(cents > 0)) rpcError("amount_cents must be greater than zero");
    if (cents > INTEGER_COLUMN_MAX) throw new HandBackToRails("an amount beyond the column");
    return { kind: "cents", cents };
  }
  return undefined;
}

// Mcp::Server#discount_window_attributes and #parse_discount_time, for a whole-second timestamp with an offset.
function discountWindow(args: Hash, defaultValidAt: Date): { valid_at?: Date; expires_at?: Date } {
  const window: { valid_at?: Date; expires_at?: Date } = {};
  for (const key of ["valid_at", "expires_at"] as const) {
    if (!(key in args)) continue;
    const text = args[key] as string;
    // Other forms (a bare date, a fraction, a blank) are read by Time.zone.iso8601 in ways the port does not follow.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[-+]\d{2}:\d{2})$/u.test(text))
      throw new HandBackToRails("a time that is not YYYY-MM-DDThh:mm:ssZ");
    const year = Number(text.slice(0, 4));
    if (year < DISCOUNT_YEAR_MIN || year > DISCOUNT_YEAR_MAX)
      rpcError(`${key} must have a year from ${DISCOUNT_YEAR_MIN} to ${DISCOUNT_YEAR_MAX}`);
    const parsed = validityPeriodOf({ [key]: text })[key];
    if (parsed === null || parsed === undefined || Number.isNaN(parsed.getTime()))
      throw new HandBackToRails("a time the port cannot read");
    window[key] = parsed;
  }
  if ("expires_at" in args && window.valid_at === undefined) window.valid_at = defaultValidAt;
  return window;
}

function discountMaxPurchaseCount(args: Hash): number {
  const count = args.max_purchase_count as number;
  if (count < 0) rpcError("max_purchase_count must be zero or more");
  if (count > INTEGER_COLUMN_MAX) throw new HandBackToRails("a count beyond the column");
  return count;
}

async function findDiscountProduct(args: Hash, context: ToolContext) {
  const id = args.product_id as string;
  if (isBlankText(id)) rpcError("product_id must not be blank");
  const found = await findProduct({ id }, context);
  return db.link.findUniqueOrThrow({ where: { id: found.id } });
}

// Mcp::Server#discount_code_payload, for a saved code of one product or all of them.
async function discountCodePayload(id: number | bigint, now: Date): Promise<Hash> {
  const row = await db.offerCode.findUniqueOrThrow({ where: { id: Number(id) } });
  const products = row.universal ? [] : await productsOfOfferCode(Number(row.id));
  if (products.length > 1) throw new HandBackToRails("a discount code with several products");
  const productIds = products.map((product) => encrypt(product.id));
  return {
    id: encrypt(row.id),
    code: row.code,
    scope: row.universal ? "universal" : (productIds[0] ?? null),
    product_ids: productIds,
    percent_off: row.amount_percentage,
    tiers: null,
    amount_cents: row.amount_cents,
    currency: row.amount_cents !== null ? row.currency_type : null,
    valid_at: row.valid_at === null ? null : iso8601(row.valid_at),
    expires_at: row.expires_at === null ? null : iso8601(row.expires_at),
    max_purchase_count: row.max_purchase_count,
    expired: row.expires_at !== null && row.expires_at <= now,
  };
}

// tool_create_discount_code for a plain code (the OfferCode port): a membership or product with options, a time in another form and
// an amount beyond the column go to Rails whole.
async function createDiscountCode(args: Hash, context: ToolContext): Promise<Hash> {
  const code = rubyStrip(args.code as string);
  if (isBlankText(code)) rpcError("code is required");
  const product = "product_id" in args ? await findDiscountProduct(args, context) : null;
  const user = context.user;
  const amount = discountAmount(args, true)!;
  const now = (context.now ?? (() => new Date()))();
  const window = discountWindow(args, now);
  const attributes: Record<string, unknown> = {
    code,
    universal: product === null,
    user_id: Number(user.id),
    ...window,
    ...(amount.kind === "percent"
      ? { amount_percentage: amount.percent, amount_cents: null, currency_type: null }
      : {
          amount_cents: amount.cents,
          amount_percentage: null,
          currency_type: product?.price_currency_type ?? user.currency_type,
        }),
  };
  if ("max_purchase_count" in args) attributes.max_purchase_count = discountMaxPurchaseCount(args);
  await assertPlainProducts(
    product === null
      ? await universalProducts(user.id, (attributes.currency_type as string | null) ?? null)
      : [product],
  );

  let saved: number | bigint | undefined;
  let failure: string | undefined;
  await transaction(async () => {
    // One seller's concurrent creates serialize here, so the second sees the first's code.
    await selectRows(Prisma.sql`SELECT id FROM users WHERE id = ${user.id} LIMIT 1 FOR UPDATE`);
    const record = buildOfferCode(attributes as never);
    if (product !== null) await addProduct(record, product);
    if (!(await OfferCodes.save(record, { now: context.now }))) failure = toSentence(record.errors.fullMessages());
    else saved = record.get("id") as number | bigint;
  });
  if (failure !== undefined) throw new ToolError(failure);
  return { discount_code: await discountCodePayload(saved!, (context.now ?? (() => new Date()))()) };
}

async function findDiscountCode(args: Hash, context: ToolContext) {
  const code = rubyStrip(args.code as string);
  if (isBlankText(code)) rpcError("code is required");
  if ("product_id" in args) {
    const product = await findDiscountProduct(args, context);
    const [row] = await db.$queryRaw<{ id: bigint }[]>`SELECT offer_codes.id FROM offer_codes
      INNER JOIN offer_codes_products ON offer_codes_products.offer_code_id = offer_codes.id
      WHERE offer_codes_products.product_id = ${product.id} AND offer_codes.deleted_at IS NULL AND offer_codes.universal = 0
        AND offer_codes.user_id = ${context.user.id} AND offer_codes.code = ${code} LIMIT 1`;
    if (row === undefined)
      throw new ToolError(
        `No discount code ${code} is limited to this product. Omit product_id for a code that covers all products.`,
      );
    return { row: await db.offerCode.findUniqueOrThrow({ where: { id: Number(row.id) } }), product };
  }
  const [row] = await db.$queryRaw<{ id: bigint }[]>`SELECT id FROM offer_codes WHERE user_id = ${context.user.id}
    AND deleted_at IS NULL AND universal = 1 AND code = ${code} LIMIT 1`;
  if (row === undefined)
    throw new ToolError(
      `No discount code ${code} covers all products. Pass product_id for a code made for specific products.`,
    );
  return { row: await db.offerCode.findUniqueOrThrow({ where: { id: Number(row.id) } }), product: null };
}

// tool_update_discount_code for a plain code whose kind of amount and currency stay as they are (a change of either re-derives which
// products the code applies to).
async function updateDiscountCode(args: Hash, context: ToolContext): Promise<Hash> {
  if (!DISCOUNT_CODE_KEYS.some((key) => key in args))
    rpcError(`Pass at least one of ${DISCOUNT_CODE_KEYS.slice(0, -1).join(", ")}, or ${DISCOUNT_CODE_KEYS.at(-1)}`);
  const { row } = await findDiscountCode(args, context);
  await assertPlainCode(row);
  const amount = discountAmount(args, false);
  const attributes: Record<string, unknown> = {};
  if (amount?.kind === "percent") {
    if (row.amount_percentage === null || OfferCodeFlags.isSet(row.flags, "once_per_cart"))
      throw new HandBackToRails("a change from a fixed amount to a percentage");
    attributes.amount_percentage = amount.percent;
  } else if (amount?.kind === "cents") {
    if (row.amount_cents === null) throw new HandBackToRails("a change from a percentage to a fixed amount");
    attributes.amount_cents = amount.cents;
  }
  const now = (context.now ?? (() => new Date()))();
  Object.assign(attributes, discountWindow(args, row.valid_at ?? row.created_at ?? now));
  if ("max_purchase_count" in args) attributes.max_purchase_count = discountMaxPurchaseCount(args);
  await assertPlainProducts(
    row.universal ? await universalProducts(row.user_id, row.currency_type) : await productsOfOfferCode(Number(row.id)),
  );

  const record = loadOfferCode(row);
  let failure: string | undefined;
  await transaction(async () => {
    if (!(await OfferCodes.update(record, attributes as never, { now: context.now })))
      failure = toSentence(record.errors.fullMessages());
  });
  if (failure !== undefined) throw new ToolError(failure);
  return { discount_code: await discountCodePayload(row.id, (context.now ?? (() => new Date()))()) };
}

// DISCOUNT_MIN_VALIDITY_WINDOW
const DISCOUNT_MIN_VALIDITY_SECONDS = 1;

// tool_expire_discount_code for a plain code. `save!(context: :expiring)` skips the price validation, so a code whose products no
// longer take its discount can still be ended; the other validations run as in an update.
async function expireDiscountCode(args: Hash, context: ToolContext): Promise<Hash> {
  const { row } = await findDiscountCode(args, context);
  await assertPlainCode(row);
  const now = new Date((context.now ?? (() => new Date()))());
  now.setMilliseconds(0);
  if (row.expires_at !== null && row.expires_at <= now)
    return { discount_code: await discountCodePayload(row.id, now), message: "Already expired." };

  const start = row.valid_at ?? row.created_at ?? now;
  const latestStart = new Date(now.getTime() - DISCOUNT_MIN_VALIDITY_SECONDS * 1000);
  const record = loadOfferCode(row);
  let failure: string | undefined;
  await transaction(async () => {
    const attributes = { valid_at: start < latestStart ? start : latestStart, expires_at: now };
    if (!(await OfferCodes.update(record, attributes, { now: context.now, context: EXPIRING_CONTEXT })))
      failure = toSentence(record.errors.fullMessages());
  });
  if (failure !== undefined) throw new ToolError(failure);
  return {
    discount_code: await discountCodePayload(row.id, now),
    message: "Expired. Buyers can no longer use this code.",
  };
}

export type SubscriptionRow = {
  id: bigint;
  link_id: bigint | null;
  product_name: string | null;
  created_at: Date;
  created_micros: bigint;
  cancelled_at: Date | null;
  failed_at: Date | null;
  ended_at: Date | null;
  deactivated_at: Date | null;
  flags: bigint;
  user_email: string | null;
  user_unconfirmed_email: string | null;
};
export type SubscriptionPurchaseRow = {
  id: bigint;
  subscription_id: bigint;
  purchase_state: string | null;
  flags: bigint | null;
  email: string | null;
  created_micros: bigint;
  // `giftee_email` of every gift the purchase sent, read for the ones flagged as gift senders.
  giftee_emails?: (string | null)[];
};
export type SubscriptionsQuery = {
  sellerId: bigint;
  productId: bigint | null;
  status: "alive" | "ended" | null;
  limit: number;
  after: { at: string; id: bigint } | null;
  now: Date;
};
export type SubscriptionsReader = {
  // The seller's non-test subscriptions, newest first (`Mcp::Server#subscriptions_payload`).
  list: (query: SubscriptionsQuery) => Promise<SubscriptionRow[]>;
  purchases: (subscriptionIds: bigint[]) => Promise<SubscriptionPurchaseRow[]>;
};

const microsOf = (column: string) => Prisma.raw(`TIMESTAMPDIFF(MICROSECOND, '1970-01-01', ${column})`);

export const readSubscriptions: SubscriptionsReader = {
  async list({ sellerId, productId, status, limit, after, now }) {
    const product = productId === null ? Prisma.empty : Prisma.sql`AND subscriptions.link_id = ${productId}`;
    // Subscription.active, whose complement is the ended list.
    const active = Prisma.sql`subscriptions.failed_at IS NULL AND subscriptions.ended_at IS NULL
      AND (subscriptions.cancelled_at IS NULL OR subscriptions.cancelled_at > ${utc(now)})`;
    const state =
      status === "alive"
        ? Prisma.sql`AND ${active}`
        : status === "ended"
          ? Prisma.sql`AND NOT (${active})`
          : Prisma.empty;
    const cursor =
      after === null
        ? Prisma.empty
        : Prisma.sql`AND (subscriptions.created_at < ${after.at} OR (subscriptions.created_at = ${after.at} AND subscriptions.id < ${after.id}))`;
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT subscriptions.id, subscriptions.link_id,
        links.name AS product_name, subscriptions.created_at, ${microsOf("subscriptions.created_at")} AS created_micros,
        subscriptions.cancelled_at, subscriptions.failed_at, subscriptions.ended_at, subscriptions.deactivated_at,
        subscriptions.flags, subscribers.email AS user_email, subscribers.unconfirmed_email AS user_unconfirmed_email
      FROM subscriptions INNER JOIN links ON links.id = subscriptions.link_id
      INNER JOIN users ON users.id = links.user_id
      LEFT JOIN users subscribers ON subscribers.id = subscriptions.user_id
      WHERE users.id = ${sellerId} AND ${SubscriptionFlags.condition("is_test_subscription", false)} ${product} ${state} ${cursor}
      ORDER BY subscriptions.created_at DESC, subscriptions.id DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      ...(row as unknown as SubscriptionRow),
      id: BigInt(row.id as bigint),
      link_id: row.link_id === null ? null : BigInt(row.link_id as bigint),
      flags: BigInt(row.flags as bigint),
      created_micros: BigInt(row.created_micros as bigint),
    }));
  },
  async purchases(subscriptionIds) {
    if (subscriptionIds.length === 0) return [];
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT id, subscription_id, purchase_state, flags, email,
        ${microsOf("created_at")} AS created_micros
      FROM purchases WHERE subscription_id IN (${Prisma.join(subscriptionIds)})`;
    if (rows.length === 0) return [];
    const gifts = await db.$queryRaw<
      { gifter_purchase_id: bigint; giftee_email: string | null }[]
    >`SELECT gifter_purchase_id,
        giftee_email FROM gifts WHERE gifter_purchase_id IN (${Prisma.join(rows.map((row) => row.id as bigint))})`;
    return rows.map((row) => ({
      ...(row as unknown as SubscriptionPurchaseRow),
      id: BigInt(row.id as bigint),
      subscription_id: BigInt(row.subscription_id as bigint),
      flags: row.flags === null ? null : BigInt(row.flags as bigint),
      created_micros: BigInt(row.created_micros as bigint),
      giftee_emails: gifts
        .filter((gift) => BigInt(gift.gifter_purchase_id) === BigInt(row.id as bigint))
        .map((gift) => gift.giftee_email),
    }));
  },
};

const isPurchaseFlag = (row: SubscriptionPurchaseRow, name: Parameters<typeof PurchaseFlags.isSet>[1]) =>
  PurchaseFlags.isSet(row.flags, name);
const presentText = (value: string | null): string | null => (value === null || value.trim() === "" ? null : value);

// Mcp::Server#subscription_email
function subscriptionEmail(row: SubscriptionRow, purchases: SubscriptionPurchaseRow[]): string | null {
  const formEmail = presentText(row.user_unconfirmed_email) ?? presentText(row.user_email);
  if (formEmail !== null) return formEmail;
  const originals = purchases
    .filter((purchase) => isPurchaseFlag(purchase, "is_original_subscription_purchase"))
    .sort((a, b) => Number(a.id - b.id));
  const trueOriginal = originals[0];
  if (trueOriginal === undefined) return null;
  // The giftee's address lives on the gift row; `gift_given` is a has_one with no order, so two gift rows are Rails's to pick from.
  if (isPurchaseFlag(trueOriginal, "is_gift_sender_purchase")) {
    const giftees = trueOriginal.giftee_emails ?? [];
    if (giftees.length > 1) throw new HandBackToRails("a gifted subscription with several gift rows");
    return giftees.length === 0 ? null : presentText(giftees[0]!);
  }
  const candidates = originals.filter(
    (purchase) => !isPurchaseFlag(purchase, "is_archived_original_subscription_purchase"),
  );
  // has_one :original_purchase has no order, so it is only the first row when it is the only one.
  if (candidates.length > 1) throw new HandBackToRails("a subscription with several original purchases");
  return (candidates[0] ?? trueOriginal).email;
}

// Subscription#status, as customers.ts reads it. A card mandate that disabled renewals changes the answer in ways that
// need the mandate's feature flag and the next charge, which are Rails's.
function subscriptionState(row: SubscriptionRow, purchases: SubscriptionPurchaseRow[], now: Date): string | null {
  if (SubscriptionFlags.isSet(row.flags, "renewal_disabled_due_to_indian_card_mandate"))
    throw new HandBackToRails("a subscription whose renewals a card mandate disabled");
  const newest = purchases.reduce<SubscriptionPurchaseRow | undefined>(
    (best, purchase) => (best === undefined || purchase.created_micros > best.created_micros ? purchase : best),
    undefined,
  );
  // max_by keeps the first of equal timestamps, in no order this port can see.
  if (
    newest !== undefined &&
    purchases.filter((purchase) => purchase.created_micros === newest.created_micros).length > 1
  )
    throw new HandBackToRails("a subscription whose newest purchases share a timestamp");
  return subscriptionStatus(
    row as unknown as Parameters<typeof subscriptionStatus>[0],
    newest?.purchase_state ?? null,
    now,
  );
}

const SUBSCRIPTION_CHURN_DEFAULT_MONTHS = 11;
const SUBSCRIPTION_CHURN_MAX_DAYS = 366;

type ChurnStats = {
  subscriber_base: number;
  churned_customers_count: number;
  churn_rate: number;
  revenue_lost_cents: number;
};
export type ChurnPayload = {
  metadata: { current_period?: { start_date: string; end_date: string } };
  data: {
    current_period?: {
      monthly?: Record<string, { total?: ChurnStats; by_product: Record<string, ChurnStats | undefined> }>;
    };
  };
};
export type ChurnReader = (user: User, startDate: string, endDate: string) => Promise<ChurnPayload>;
const readChurn: ChurnReader = async (user, startDate, endDate) => {
  try {
    return (await churnData(user, { startDate, endDate })) as unknown as ChurnPayload;
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
};

// `Date - n.months` (the day is clamped to the shorter month), then beginning_of_month.
function startOfMonthsBefore(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) - months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
}

// Mcp::Server#churn_payload: CreatorAnalytics::Churn (the dashboard's source) by month, `churn_rate` a Ruby Float.
async function getChurn(args: Hash, context: ToolContext, product: ProductDetailRow | null): Promise<Hash> {
  const zone = context.user.timezone;
  let today: CalendarDate;
  try {
    today = parseDate(instantInTimeZoneIso8601(zone, (context.now ?? (() => new Date()))()).slice(0, 10), "today");
  } catch (error) {
    if (error instanceof InvalidTimeZoneError)
      throw new HandBackToRails("an MCP tool for a seller with an unknown time zone");
    throw error;
  }
  const end = typeof args.end_date === "string" ? parseDate(args.end_date, "end_date") : today;
  const start =
    typeof args.start_date === "string"
      ? parseDate(args.start_date, "start_date")
      : startOfMonthsBefore(end, SUBSCRIPTION_CHURN_DEFAULT_MONTHS);
  const days = (dateMs(end) - dateMs(start)) / DAY_MS;
  if (days < 0) throw new ToolRpcError("start_date must not be after end_date", INVALID_PARAMS);
  if (days >= SUBSCRIPTION_CHURN_MAX_DAYS)
    throw new ToolRpcError(`The date range cannot exceed ${SUBSCRIPTION_CHURN_MAX_DAYS} days`, INVALID_PARAMS);

  if (isoDate(start) > isoDate(today))
    return {
      breakdown: "churn",
      start_date: isoDate(start),
      end_date: isoDate(end),
      time_zone: zone,
      currency: USD,
      rows: [],
    };

  const data = await (context.churn ?? readChurn)(context.user, isoDate(start), isoDate(end));
  const monthly = data.data.current_period?.monthly ?? {};
  const rows = Object.entries(monthly).flatMap(([month, monthStats]) => {
    const stats = product === null ? monthStats.total : monthStats.by_product[product.unique_permalink ?? ""];
    if (stats === undefined) return [];
    return [
      {
        month,
        subscriber_base: stats.subscriber_base,
        churned: stats.churned_customers_count,
        churn_rate_percent: new FloatValue(stats.churn_rate),
        revenue_lost_cents: stats.revenue_lost_cents,
      },
    ];
  });
  // The churn source clamps the range to the seller's first sale and today, so return what it read.
  const period = data.metadata.current_period;
  return {
    breakdown: "churn",
    start_date: period?.start_date ?? isoDate(start),
    end_date: period?.end_date ?? isoDate(end),
    time_zone: zone,
    currency: USD,
    rows,
  };
}

// tool_get_subscriptions
async function getSubscriptions(args: Hash, context: ToolContext): Promise<Hash> {
  const breakdown = "breakdown" in args ? args.breakdown : "subscriptions";
  let product: ProductDetailRow | null = null;
  if (isPresent(args.product_id)) {
    product = await (context.products ?? readProducts).find(BigInt(context.user.id), args.product_id);
    if (product === null) throw new ToolError("The product was not found.");
  }
  if (breakdown === "churn") return getChurn(args, context, product);
  const limit = limitFor(args, 25);
  const after = parseCursor(args);
  const status = args.status === "alive" || args.status === "ended" ? args.status : null;
  if (args.status !== undefined && status === null) throw new HandBackToRails("a subscription status filter");
  const now = (context.now ?? (() => new Date()))();
  const reader = context.subscriptions ?? readSubscriptions;
  const rows = await reader.list({
    sellerId: BigInt(context.user.id),
    productId: product?.id ?? null,
    status,
    limit: limit + 1,
    after,
    now,
  });
  const page = rows.slice(0, limit);
  const purchases = await reader.purchases(page.map((row) => row.id));
  const subscriptions = page.map((row) => {
    const own = purchases.filter((purchase) => purchase.subscription_id === row.id);
    return {
      id: encrypt(row.id),
      product_id: row.link_id === null ? null : encrypt(row.link_id),
      product_name: row.product_name,
      email: subscriptionEmail(row, own),
      status: subscriptionState(row, own, now),
      started_at: iso8601(row.created_at),
      cancelled_at: row.cancelled_at === null ? null : iso8601(row.cancelled_at),
      failed_at: row.failed_at === null ? null : iso8601(row.failed_at),
      ended_at: row.ended_at === null ? null : iso8601(row.ended_at),
      failed_payments: own.filter((purchase) => purchase.purchase_state === "failed").length,
    };
  });
  const last = page[page.length - 1];
  return {
    breakdown: "subscriptions",
    subscriptions,
    ...(rows.length > limit && last !== undefined ? { next_cursor: `${last.created_micros}_${last.id}` } : {}),
  };
}

const ANALYTICS_DEFAULT_DAYS = 30;
const ANALYTICS_MAX_DAYS = 366;
const ANALYTICS_MAX_REFERRERS = 50;
const CONVERSION_DIGITS = 4;
// A key a JavaScript object keeps in numeric order, ahead of the others, where a Ruby Hash keeps insertion order.
const REORDERED_KEY = /^(?:0|[1-9]\d{0,8})$/u;

export type AnalyticsSeries = Record<string, number[]>;
export type AnalyticsReader = {
  // CreatorAnalytics::CachingProxy#data_for_dates, with civil dates.
  data: (user: User, start: string, end: string, by: "date" | "referral") => Promise<Hash>;
  // `user.links.where(unique_permalink: ...)`, deleted products included.
  names: (userId: bigint, permalinks: string[]) => Promise<Map<string, { id: bigint; name: string | null }>>;
};

export const readAnalytics: AnalyticsReader = {
  async data(user, start, end, by) {
    try {
      return (await new CreatorAnalyticsCachingProxy(user).dataForDates(start, end, by)) as Hash;
    } catch (error) {
      if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
      throw error;
    }
  },
  async names(userId, permalinks) {
    const rows = await db.link.findMany({
      where: { user_id: userId, unique_permalink: { in: permalinks } },
      select: { id: true, name: true, unique_permalink: true },
    });
    return new Map(rows.map((row) => [row.unique_permalink ?? "", { id: row.id, name: row.name }]));
  },
};

const sumOf = (series: number[]): number => series.reduce((total, value) => total + value, 0);
// Mcp::Server#analytics_conversion
const conversion = (sales: number, views: number): FloatValue | null =>
  views > 0 ? new FloatValue(rubyRoundHalfUp(sales / views, CONVERSION_DIGITS)) : null;

// sort_by { -views }: Ruby's introsort for Integer keys, which leaves rows with equal views in an order of its own.
const sortedByViews = <T extends { views: number }>(rows: T[]): T[] => rubySortByInteger(rows, (row) => -row.views);

function assertInsertionOrdered(keys: string[]): void {
  if (keys.some((key) => REORDERED_KEY.test(key)))
    throw new HandBackToRails("get_analytics keys that look like numbers");
}

// tool_get_analytics
async function getAnalytics(args: Hash, context: ToolContext): Promise<Hash> {
  const zone = context.user.timezone;
  const now = (context.now ?? (() => new Date()))();
  let today: CalendarDate;
  let createdOn: string;
  try {
    today = parseDate(instantInTimeZoneIso8601(zone, now).slice(0, 10), "today");
    if (context.user.created_at === null)
      throw new HandBackToRails("get_analytics for a seller without a creation time");
    createdOn = instantInTimeZoneIso8601(zone, context.user.created_at).slice(0, 10);
  } catch (error) {
    if (error instanceof InvalidTimeZoneError)
      throw new HandBackToRails("an MCP tool for a seller with an unknown time zone");
    throw error;
  }
  const end = typeof args.end_date === "string" ? parseDate(args.end_date, "end_date") : today;
  const start =
    typeof args.start_date === "string"
      ? parseDate(args.start_date, "start_date")
      : fromMs(dateMs(end) - (ANALYTICS_DEFAULT_DAYS - 1) * DAY_MS);
  const days = (dateMs(end) - dateMs(start)) / DAY_MS;
  if (days < 0) throw new ToolRpcError("start_date must not be after end_date", INVALID_PARAMS);
  if (days >= ANALYTICS_MAX_DAYS)
    throw new ToolRpcError(`The date range cannot exceed ${ANALYTICS_MAX_DAYS} days`, INVALID_PARAMS);

  let permalink: string | null = null;
  if (isPresent(args.product_id)) {
    const product = await (context.products ?? readProducts).find(BigInt(context.user.id), args.product_id);
    if (product === null) throw new ToolError("The product was not found.");
    permalink = product.unique_permalink;
  }
  const breakdown = "breakdown" in args ? args.breakdown : "product";
  const base = { start_date: isoDate(start), end_date: isoDate(end), time_zone: zone, currency: USD, breakdown };
  // CachingProxy clamps ranges to [account creation, today]; a range wholly outside would be answered with another day's data.
  if (isoDate(start) > isoDate(today) || isoDate(end) < createdOn) return { ...base, rows: [] };

  const reader = context.analytics ?? readAnalytics;
  const referrer = breakdown === "referrer";
  const data = await reader.data(context.user, isoDate(start), isoDate(end), referrer ? "referral" : "date");
  const wanted = (name: string) => permalink === null || name === permalink;

  if (referrer) {
    const byReferral = data.by_referral as Record<"views" | "sales" | "totals", Record<string, AnalyticsSeries>>;
    const totals = new Map<string, { views: number; sales: number; revenue_cents: number }>();
    for (const [type, field] of [
      ["views", "views"],
      ["sales", "sales"],
      ["totals", "revenue_cents"],
    ] as const) {
      assertInsertionOrdered(Object.keys(byReferral[type]));
      for (const [name, referrers] of Object.entries(byReferral[type])) {
        if (!wanted(name)) continue;
        assertInsertionOrdered(Object.keys(referrers));
        for (const [referrerName, series] of Object.entries(referrers)) {
          const row = totals.get(referrerName) ?? { views: 0, sales: 0, revenue_cents: 0 };
          row[field] += sumOf(series);
          totals.set(referrerName, row);
        }
      }
    }
    const rows = sortedByViews([...totals].map(([name, row]) => ({ referrer: name, ...row })))
      .slice(0, ANALYTICS_MAX_REFERRERS)
      .map((row) => ({ ...row, conversion_rate: conversion(row.sales, row.views) }));
    return { ...base, rows };
  }

  const byDate = data.by_date as Record<"views" | "sales" | "totals", Record<string, number[]>>;
  const permalinks = Object.keys(byDate.views);
  assertInsertionOrdered(permalinks);
  const names = await reader.names(BigInt(context.user.id), permalinks);
  const rows = sortedByViews(
    permalinks.filter(wanted).map((name) => ({
      product_id: names.has(name) ? encrypt(names.get(name)!.id) : null,
      product_name: names.get(name)?.name ?? null,
      views: sumOf(byDate.views[name]!),
      sales: sumOf(byDate.sales[name]!),
      revenue_cents: sumOf(byDate.totals[name]!),
    })),
  ).map((row) => ({ ...row, conversion_rate: conversion(row.sales, row.views) }));
  return { ...base, rows };
}

// The payload of a ported tool, or undefined for a tool that still runs in Rails.
export async function toolBody(name: string, args: Hash, context: ToolContext): Promise<Hash | undefined> {
  switch (name) {
    case "get_account":
      await requireScopes(context.token, ["view_profile", "view_public", "view_sales", "account"]);
      return getAccount(context.user);
    case "list_payouts":
      await requireScopes(context.token, ["view_payouts", "account"]);
      return listPayouts(args, context);
    case "get_customers":
      await requireScopes(context.token, ["view_sales", "account"]);
      return getCustomers(args, context);
    case "get_sales_totals":
      await requireScopes(context.token, ["view_sales", "account"]);
      return getSalesTotals(args, context);
    case "list_products":
      await requireScopes(context.token, ["view_profile", "view_public", "edit_products", "account"]);
      return listProducts(args, context);
    case "list_sales":
      await requireScopes(context.token, ["view_sales", "account"]);
      return listSales(args, context);
    case "list_purchases":
      // Deliberately not "account": the buyer's library has its own scope.
      await requireScopes(context.token, ["view_library"]);
      return listPurchases(args, context);
    case "get_product":
      await requireScopes(context.token, ["view_profile", "view_public", "edit_products", "account"]);
      return getProduct(args, context);
    case "list_categories":
      await requireScopes(context.token, ["view_profile", "view_public", "edit_products", "account"]);
      return listCategories();
    case "create_draft_product":
      return createDraftProduct(args, context);
    case "update_product":
      await requireScopes(context.token, ["edit_products", "account"]);
      return updateProduct(args, context);
    case "create_discount_code":
      await requireScopes(context.token, ["edit_products", "account"]);
      return createDiscountCode(args, context);
    case "update_discount_code":
      await requireScopes(context.token, ["edit_products", "account"]);
      return updateDiscountCode(args, context);
    case "expire_discount_code":
      await requireScopes(context.token, ["edit_products", "account"]);
      return expireDiscountCode(args, context);
    case "publish_product":
      await requireScopes(context.token, ["edit_products", "account"]);
      return setPublication(args, context, true);
    case "unpublish_product":
      await requireScopes(context.token, ["edit_products", "account"]);
      return setPublication(args, context, false);
    case "get_subscriptions":
      await requireScopes(context.token, ["view_sales", "account"]);
      return getSubscriptions(args, context);
    case "get_analytics":
      await requireScopes(context.token, ["view_sales", "account"]);
      return getAnalytics(args, context);
    case "list_files":
      await requireScopes(context.token, ["edit_products", "account"]);
      return listFiles(args, context);
    default:
      return undefined;
  }
}
