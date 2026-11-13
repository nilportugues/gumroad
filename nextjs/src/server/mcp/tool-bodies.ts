// Bodies of the pure-read tools of app/services/mcp/server.rb: get_account, list_payouts, get_customers and get_sales_totals.
// Every other tool still runs in Rails (toolBody returns undefined for it). A call whose token lacks the tool's scope also
// stays in Rails, which owns the 403 scope challenge and the batch variant of that error. So do these sub-cases:
// get_customers with a date in an ISO 8601 form other than YYYY-MM-DD or a query timeout;
// get_sales_totals with a country, day, week or month breakdown (tzinfo transitions, Compliance::Countries); and a
// product_id that does not resolve (Rails answers with a tool-level error result).
import { Prisma } from "@prisma/client";
import type { OauthAccessToken, User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { HandBackToRails } from "../controllers/application-controller.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import {
  instantInTimeZoneIso8601,
  InvalidTimeZoneError,
  startOfDayIso8601,
} from "../models/concerns/rails-time-zone.ts";
import { domainConfig } from "../page-props/domain.ts";
import { PurchaseFlags } from "../search/flags.ts";

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
export type SalesTotalsReader = {
  byProduct: (query: ProductTotalsQuery) => Promise<ProductTotalsRow[]>;
  productNames: (ids: bigint[]) => Promise<Map<bigint, string>>;
  // user.links.find_by_external_id, then unique_permalink, then custom_permalink; a deleted product is not found.
  findProductId: (userId: bigint, id: string) => Promise<bigint | null>;
};

export type ToolContext = {
  user: User;
  token: OauthAccessToken;
  payouts?: PayoutReader;
  customers?: CustomerReader;
  salesTotals?: SalesTotalsReader;
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

// Mcp::Server#require_scopes!, for a token that passes. A failure is Rails's to answer.
function requireScopes(token: OauthAccessToken, scopes: string[]): void {
  const held = (token.scopes ?? "").split(/\s+/u).filter((scope) => scope !== "");
  if (!scopes.some((scope) => held.includes(scope)))
    throw new HandBackToRails("an MCP tool call without the scope the tool needs");
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

export const readSalesTotals: SalesTotalsReader = {
  async byProduct(query) {
    const conditions = [
      Prisma.sql`purchases.seller_id = ${query.sellerId}`,
      Prisma.sql`purchases.purchase_state IN (${Prisma.join(KEPT_SUCCESS_STATES)})`,
      Prisma.sql`(purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0)`,
      Prisma.sql`(purchases.chargeback_date IS NULL OR purchases.flags & ${String(PurchaseFlags.bit("chargeback_reversed"))} != 0)`,
      flagSql("is_gift_receiver_purchase", false),
      flagSql("is_bundle_product_purchase", false),
      Prisma.sql`purchases.created_at >= ${query.from}`,
      Prisma.sql`purchases.created_at < ${query.until}`,
    ];
    if (query.productId !== null) conditions.push(Prisma.sql`purchases.link_id = ${query.productId}`);
    // A commission completion is a second payment on the order: it adds revenue but not a unit.
    const rows = await db.$queryRaw<Record<string, unknown>[]>`SELECT purchases.link_id AS link_id,
        SUM(purchases.price_cents) AS revenue_cents,
        SUM(CASE WHEN ${flagSql("is_commission_completion_purchase", false)} THEN 1 ELSE 0 END) AS units
      FROM purchases WHERE ${Prisma.join(conditions, " AND ")} GROUP BY purchases.link_id ORDER BY purchases.link_id`;
    return rows.map((row) => ({
      link_id: BigInt(row.link_id as bigint),
      revenue_cents: num(row.revenue_cents),
      units: num(row.units),
    }));
  },
  async productNames(ids) {
    const links = await db.link.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(links.map((link) => [link.id, link.name]));
  },
  async findProductId(userId, id) {
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
  },
};

type CalendarDate = { year: number; month: number; day: number };

// Date.iso8601 for the YYYY-MM-DD form. A string Ruby may still parse in another ISO 8601 form is Rails's to read;
// a well-formed date that is not on the calendar is the tool's own error.
function parseDate(value: string, name: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) throw new HandBackToRails("an MCP date argument that is not YYYY-MM-DD");
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
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
          // A Float: Ruby writes 3.0 where a JavaScript number would be written 3.
          days_to_convert: new RubyFloat(days),
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
    if (String((error as Error)?.message).includes("maximum statement execution time exceeded"))
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

// tool_get_sales_totals, for breakdown=product.
async function getSalesTotals(args: Hash, context: ToolContext): Promise<Hash> {
  const zone = context.user.timezone;
  const breakdown = "breakdown" in args ? args.breakdown : "product";
  if (breakdown !== "product")
    throw new HandBackToRails("a sales totals breakdown that needs zone transitions or country names");
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
    if (productId === null) throw new HandBackToRails("a product_id that does not resolve");
  }
  const rows = await readers.byProduct({
    sellerId,
    productId,
    from: dayStartUtc(zone, start),
    until: dayStartUtc(zone, fromMs(dateMs(end) + DAY_MS)),
  });
  const top = rows.toSorted((a, b) => b.revenue_cents - a.revenue_cents).slice(0, TOTALS_MAX_ROWS);
  const names = await readers.productNames(top.map((row) => row.link_id));
  return {
    start_date: isoDate(start),
    end_date: isoDate(end),
    time_zone: zone,
    currency: USD,
    breakdown,
    totals: salesMetrics(
      rows.reduce((sum, row) => sum + row.revenue_cents, 0),
      rows.reduce((sum, row) => sum + row.units, 0),
    ),
    rows: top.map((row) => ({
      product_id: encrypt(row.link_id),
      product_name: names.get(row.link_id) ?? null,
      ...salesMetrics(row.revenue_cents, row.units),
    })),
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

// The payload of a ported tool, or undefined for a tool that still runs in Rails.
export async function toolBody(name: string, args: Hash, context: ToolContext): Promise<Hash | undefined> {
  switch (name) {
    case "get_account":
      requireScopes(context.token, ["view_profile", "view_public", "view_sales", "account"]);
      return getAccount(context.user);
    case "list_payouts":
      requireScopes(context.token, ["view_payouts", "account"]);
      return listPayouts(args, context);
    case "get_customers":
      requireScopes(context.token, ["view_sales", "account"]);
      return getCustomers(args, context);
    case "get_sales_totals":
      requireScopes(context.token, ["view_sales", "account"]);
      return getSalesTotals(args, context);
    default:
      return undefined;
  }
}
