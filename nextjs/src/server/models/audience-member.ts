// Port of AudienceMember.normalize_filter_params and AudienceMember.filter (app/models/audience_member.rb): the SQL a
// seller's audience filter builds, written as ActiveRecord's `to_sql` writes it, and the reads callers make of the
// relation (`first`, `count`, `limit(n).count`). The relation is a handful of text fragments, not a query builder.
// Golden: __fixtures__/audience-member-filter.golden.json (scripts/golden/audience-member-filter.rb): the text of every
// branch, for a matrix of params and options.
import { Prisma } from "@prisma/client";

import { castBoolean } from "./with-filtering.ts";
import { quote } from "./runtime/quoting.ts";
import { selectRows } from "./sql.ts";
import { ArgumentError } from "./with-filtering.ts";

export const VALID_FILTER_TYPES = ["customer", "follower", "affiliate"] as const;

export type FilterParams = {
  type?: string | null;
  bought_product_ids?: number[] | null;
  bought_variant_ids?: number[] | null;
  not_bought_product_ids?: number[] | null;
  not_bought_variant_ids?: number[] | null;
  paid_more_than_cents?: number | null;
  paid_less_than_cents?: number | null;
  created_after?: string | null;
  created_before?: string | null;
  bought_from?: string | null;
  active_customers_only?: boolean | string | null;
  minimum_license_uses?: number | null;
  affiliate_product_ids?: number[] | null;
  waitlisted_product_ids?: (number | null)[] | null;
  exclude_emails?: string[] | null;
};

export type FilterOptions = { withIds?: boolean; ids?: number[] | null; asOf?: Date | null; purchaseIds?: number[] | null };

const FILTER_PARAM_KEYS = [
  "type",
  "bought_product_ids",
  "bought_variant_ids",
  "not_bought_product_ids",
  "not_bought_variant_ids",
  "paid_more_than_cents",
  "paid_less_than_cents",
  "created_after",
  "created_before",
  "bought_from",
  "active_customers_only",
  "minimum_license_uses",
  "affiliate_product_ids",
  "waitlisted_product_ids",
  "exclude_emails",
] as const;

// `blank?` of a param value (compact_blank): nil, false, an empty string or collection.
const blankValue = (value: unknown): boolean => value === null || value === undefined || value === false || (typeof value === "string" && /^[\t\n\v\f\r ]*$/u.test(value)) || (Array.isArray(value) && value.length === 0);

// `normalize_filter_params(params)`
export function normalizeFilterParams(params: FilterParams): FilterParams {
  const sliced: Record<string, unknown> = {};
  for (const key of FILTER_PARAM_KEYS) if (key in params) sliced[key] = (params as Record<string, unknown>)[key];
  if ("active_customers_only" in sliced) sliced.active_customers_only = castBoolean(sliced.active_customers_only as never);
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sliced)) if (!blankValue(value)) compacted[key] = value;
  const type = compacted.type;
  if (type !== undefined && !(VALID_FILTER_TYPES as readonly unknown[]).includes(type)) {
    throw new ArgumentError(`Invalid type: ${String(type)}. Must be one of: ${VALID_FILTER_TYPES.join(", ")}`);
  }
  return compacted as FilterParams;
}

const AUDIENCE_MEMBERS = "`audience_members`";
const STAR = `${AUDIENCE_MEMBERS}.*`;

// A value bound to a `?` of a where string: ActiveRecord's sanitize_sql_array quotes every scalar as a string.
const bound = (value: number | string | Date): string => (typeof value === "number" ? `'${String(value)}'` : quote(value));
const boundList = (values: readonly (number | string)[]): string => values.map(bound).join(", ");
// `where(column => values)` as a hash condition: `=`, `IN (...)`, `IS NULL`; typed, not bound as strings.
function hashIn(columnSql: string, values: readonly (number | string | null)[]): string {
  if (values.length === 0) return "1=0";
  const present = values.filter((value): value is number | string => value !== null);
  if (present.length !== values.length && present.length !== 0) throw new Error("a list that mixes ids and NULL");
  if (present.length === 0) return `${columnSql} IS NULL`;
  if (present.length === 1) return `${columnSql} = ${quote(present[0])}`;
  return `${columnSql} IN (${present.map(quote).join(", ")})`;
}

const JSON_TABLE = [
  "JSON_TABLE(details, '$' COLUMNS (",
  "NESTED PATH '$.follower' COLUMNS (",
  "follower_id INT PATH '$.id',",
  "follower_created_at DATETIME PATH '$.created_at'",
  "),",
  "NESTED PATH '$.purchases[*]' COLUMNS (",
  "purchase_id INT PATH '$.id',",
  "purchase_product_id INT PATH '$.product_id',",
  "NESTED PATH '$.variant_ids[*]' COLUMNS (purchase_variant_id INT PATH '$'),",
  "purchase_price_cents INT PATH '$.price_cents',",
  "purchase_created_at DATETIME PATH '$.created_at',",
  "purchase_country CHAR(100) PATH '$.country',",
  "purchase_subscription_cancelled INT PATH '$.subscription_cancelled'",
  "),",
  "NESTED PATH '$.affiliates[*]' COLUMNS (",
  "affiliate_id INT PATH '$.id',",
  "affiliate_product_id INT PATH '$.product_id',",
  "affiliate_created_at DATETIME PATH '$.created_at'",
  ")",
  "))",
].join(" ");

const AFFILIATE_JSON_TABLE = [
  "JSON_TABLE(details, '$.affiliates[*]' COLUMNS (",
  "affiliate_id INT PATH '$.id',",
  "affiliate_product_id INT PATH '$.product_id',",
  "affiliate_created_at DATETIME PATH '$.created_at'",
  "))",
].join(" ");

// The relation `AudienceMember.filter` returns, as far as callers use it.
export type AudienceRelation =
  | { kind: "scope"; where: string }
  | { kind: "joined"; from: string; joins: string; select: string | null; distinct: boolean; limited?: undefined };

// A scoped query that builds its `WHERE` from conditions joined with AND.
class Scope {
  constructor(
    readonly conditions: readonly string[],
    readonly joins: readonly string[] = [],
  ) {}

  where(condition: string): Scope {
    return new Scope([...this.conditions, condition], this.joins);
  }

  // `where("sql", *binds)`: a string condition is wrapped in parentheses.
  whereSql(condition: string): Scope {
    return this.where(`(${condition})`);
  }

  join(sql: string): Scope {
    return new Scope(this.conditions, [...this.joins, sql]);
  }

  toSql(select = STAR, groupById = false): string {
    const joins = this.joins.map((join) => ` ${join}`).join("");
    return `SELECT ${select} FROM ${AUDIENCE_MEMBERS}${joins} WHERE ${this.conditions.join(" AND ")}${groupById ? ` GROUP BY ${AUDIENCE_MEMBERS}.\`id\`` : ""}`;
  }
}

const times = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));

// `AudienceMember.filter(seller_id:, params:, with_ids:, ids:, as_of:, purchase_ids:)`
export function filterAudience(sellerId: number, rawParams: FilterParams, options: FilterOptions = {}): AudienceRelation {
  const params = normalizeFilterParams(rawParams);
  const { withIds = false, ids = null, asOf = null, purchaseIds = null } = options;

  let baseScope = new Scope([`${AUDIENCE_MEMBERS}.\`seller_id\` = ${sellerId}`]);
  if (ids !== null) baseScope = baseScope.where(hashIn(`${AUDIENCE_MEMBERS}.\`id\``, ids));
  if (asOf !== null) baseScope = baseScope.where(`${AUDIENCE_MEMBERS}.\`created_at\` <= ${quote(asOf)}`);
  const exclude = params.exclude_emails;
  if (exclude !== undefined && exclude !== null && exclude.length > 0) {
    const column = `${AUDIENCE_MEMBERS}.\`email\``;
    baseScope = baseScope.where(exclude.length === 1 ? `${column} != ${quote(exclude[0])}` : `${column} NOT IN (${exclude.map(quote).join(", ")})`);
  }

  let typesSql: string | null = null;
  if (params.type) typesSql = baseScope.where(`${AUDIENCE_MEMBERS}.\`${params.type}\` = TRUE`).toSql();

  const containsAny = (path: string, values: readonly number[]) => values.map(() => `JSON_CONTAINS(details->'${path}', ?)`);
  const fill = (template: string[], values: readonly (number | string)[]) => {
    // Substitutes the `?` of each template in order with the bound values.
    let index = 0;
    return template.map((part) => part.replaceAll("?", () => bound(values[index++]!))).join(" OR ");
  };

  let productsSql: string | undefined;
  if (params.bought_product_ids) {
    const ids = params.bought_product_ids;
    productsSql = baseScope.whereSql(fill(containsAny("$.purchases[*].product_id", ids), ids)).toSql();
  }
  let variantsSql: string | undefined;
  if (params.bought_variant_ids) {
    const ids = params.bought_variant_ids;
    variantsSql = baseScope.whereSql(fill(containsAny("$.purchases[*].variant_ids[*]", ids), ids)).toSql();
  }
  const boughtUnion = [productsSql, variantsSql].filter((sql): sql is string => sql !== undefined).join(" UNION ") || null;

  const notBought = (path: string, values: readonly number[]) => {
    const part = `(JSON_CONTAINS(details->'${path}', ?) IS NULL OR JSON_CONTAINS(details->'${path}', ?) = 0)`;
    const binds = values.flatMap((value) => [value, value]);
    let index = 0;
    return baseScope.whereSql(times(values.length, () => part).join(" AND ").replaceAll("?", () => bound(binds[index++]!))).toSql();
  };
  const notBoughtProductsSql = params.not_bought_product_ids ? notBought("$.purchases[*].product_id", params.not_bought_product_ids) : null;
  const notBoughtVariantsSql = params.not_bought_variant_ids ? notBought("$.purchases[*].variant_ids[*]", params.not_bought_variant_ids) : null;

  let pricesSql: string | null = null;
  const { paid_more_than_cents: paidMore, paid_less_than_cents: paidLess } = params;
  if (paidMore !== undefined || paidLess !== undefined) {
    let prices = baseScope;
    if (paidMore !== undefined && paidMore !== null) prices = prices.whereSql(`max_paid_cents > ${bound(paidMore)}`);
    if (paidLess !== undefined && paidLess !== null) prices = prices.whereSql(`min_paid_cents < ${bound(paidLess)}`);
    pricesSql = prices.toSql();
  }

  let createdAtSql: string | null = null;
  if (params.created_after || params.created_before) {
    const [minColumn, maxColumn] =
      params.type === "customer"
        ? ["min_purchase_created_at", "max_purchase_created_at"]
        : params.type === "follower"
          ? ["follower_created_at", "follower_created_at"]
          : params.type === "affiliate"
            ? ["min_affiliate_created_at", "max_affiliate_created_at"]
            : ["min_created_at", "max_created_at"];
    let created = baseScope;
    if (params.created_after) created = created.whereSql(`${maxColumn} > ${bound(params.created_after)}`);
    if (params.created_before) created = created.whereSql(`${minColumn} < ${bound(params.created_before)}`);
    createdAtSql = created.toSql();
  }

  const countrySql = params.bought_from ? baseScope.whereSql(`JSON_CONTAINS(details->'$.purchases[*].country', ${bound(`"${params.bought_from}"`)})`).toSql() : null;

  let affiliatesSql: string | null = null;
  if (params.affiliate_product_ids) {
    const ids = params.affiliate_product_ids;
    affiliatesSql = baseScope.whereSql(fill(containsAny("$.affiliates[*].product_id", ids), ids)).toSql();
  }

  // Reads live `waitlist_entries` rows, which the details JSON does not carry.
  let waitlistedSql: string | null = null;
  if (params.waitlisted_product_ids) {
    const waitlisted = [
      "`followers`.`deleted_at` IS NULL",
      "`followers`.`confirmed_at` IS NOT NULL",
      "(followers.followed_id = audience_members.seller_id AND followers.email = audience_members.email)",
      hashIn("`waitlist_entries`.`product_id`", params.waitlisted_product_ids),
      ...(asOf === null ? [] : [`\`followers\`.\`confirmed_at\` <= ${quote(asOf)}`, `\`waitlist_entries\`.\`created_at\` <= ${quote(asOf)}`]),
    ];
    waitlistedSql = baseScope
      .where(`EXISTS (SELECT \`followers\`.* FROM \`followers\` INNER JOIN \`waitlist_entries\` ON \`waitlist_entries\`.\`follower_id\` = \`followers\`.\`id\` WHERE ${waitlisted.join(" AND ")})`)
      .toSql();
  }

  const purchaseDetailFilterPresent = [params.paid_more_than_cents, params.paid_less_than_cents, params.created_after, params.created_before, params.bought_from, params.active_customers_only, params.minimum_license_uses].some(has);
  let filterPurchasesWhen: unknown = (params.bought_product_ids || params.bought_variant_ids || params.affiliate_product_ids) && purchaseDetailFilterPresent;
  filterPurchasesWhen ||= params.paid_more_than_cents !== undefined && params.paid_less_than_cents !== undefined;
  filterPurchasesWhen ||= params.created_after && params.created_before;
  filterPurchasesWhen ||= params.active_customers_only || has(params.minimum_license_uses);

  let jsonFilterSql: string | null = null;
  if (filterPurchasesWhen || withIds || asOf !== null || purchaseIds !== null) {
    let json = baseScope.join(`INNER JOIN ${JSON_TABLE} AS jt`);
    if (purchaseIds !== null) json = json.whereSql(`jt.purchase_id IN (${boundList(purchaseIds)})`);
    if (params.type === "affiliate") {
      json = json.join(`INNER JOIN ${AFFILIATE_JSON_TABLE} AS affiliate_jt`);
      if (params.affiliate_product_ids) json = json.whereSql(`affiliate_jt.affiliate_product_id IN (${boundList(params.affiliate_product_ids)})`);
      if (params.created_after) json = json.whereSql(`affiliate_jt.affiliate_created_at > ${bound(params.created_after)}`);
      if (params.created_before) json = json.whereSql(`affiliate_jt.affiliate_created_at < ${bound(params.created_before)}`);
    }
    if (has(paidMore)) json = json.whereSql(`jt.purchase_price_cents > ${bound(paidMore!)}`);
    if (has(paidLess)) json = json.whereSql(`jt.purchase_price_cents < ${bound(paidLess!)}`);
    if (params.active_customers_only) json = json.whereSql("jt.purchase_id IS NOT NULL AND COALESCE(jt.purchase_subscription_cancelled, 0) = 0");
    if (has(params.minimum_license_uses)) {
      json = json.join("INNER JOIN licenses ON licenses.purchase_id = jt.purchase_id AND licenses.deleted_at IS NULL").whereSql(`licenses.uses >= ${bound(Math.trunc(params.minimum_license_uses!))}`);
    }
    const timestampColumns =
      params.type === "customer"
        ? ["purchase_created_at"]
        : params.type === "follower"
          ? params.bought_product_ids || params.bought_variant_ids
            ? ["follower_created_at", "purchase_created_at"]
            : ["follower_created_at"]
          : params.type === "affiliate"
            ? []
            : ["purchase_created_at", "follower_created_at", "affiliate_created_at"];
    if (params.created_after && timestampColumns.length > 0) json = json.whereSql(timestampColumns.map((name) => `jt.${name} > ${bound(params.created_after!)}`).join(" OR "));
    if (params.created_before && timestampColumns.length > 0) json = json.whereSql(timestampColumns.map((name) => `jt.${name} < ${bound(params.created_before!)}`).join(" OR "));
    if (asOf !== null) {
      const purchasePredicate = [params.bought_product_ids, params.bought_variant_ids, params.paid_more_than_cents, params.paid_less_than_cents, params.bought_from, params.active_customers_only, params.minimum_license_uses].some(has);
      const asOfBound = bound(asOf);
      if (params.type === "customer") {
        json = json.whereSql(`jt.purchase_created_at <= ${asOfBound}`);
      } else if (params.type === "follower") {
        json = json.join("INNER JOIN followers ON followers.followed_id = audience_members.seller_id AND followers.email = audience_members.email").whereSql(`followers.confirmed_at <= ${asOfBound}`);
        if (purchasePredicate) json = json.whereSql(`jt.purchase_created_at <= ${asOfBound}`);
      } else if (params.type === "affiliate") {
        json = json.whereSql(`affiliate_jt.affiliate_created_at <= ${asOfBound}`);
        if (purchasePredicate) json = json.whereSql(`jt.purchase_created_at <= ${asOfBound}`);
      } else {
        json = json.whereSql(`COALESCE(jt.purchase_created_at, jt.follower_created_at, jt.affiliate_created_at) <= ${asOfBound}`);
      }
    }
    if (params.bought_product_ids && params.bought_variant_ids) {
      json = json.whereSql(`jt.purchase_product_id IN (${boundList(params.bought_product_ids)}) OR jt.purchase_variant_id IN (${boundList(params.bought_variant_ids)})`);
    } else {
      if (params.bought_product_ids) json = json.whereSql(`jt.purchase_product_id IN (${boundList(params.bought_product_ids)})`);
      if (params.bought_variant_ids) json = json.whereSql(`jt.purchase_variant_id IN (${boundList(params.bought_variant_ids)})`);
    }
    if (params.affiliate_product_ids && params.type !== "affiliate") json = json.whereSql(`jt.affiliate_product_id IN (${boundList(params.affiliate_product_ids)})`);
    if (params.bought_from) json = json.whereSql(`jt.purchase_country = ${bound(params.bought_from)} COLLATE utf8mb4_bin`);

    if (withIds) {
      const followerIdSelect = params.type === "follower" ? "max(CAST(JSON_UNQUOTE(JSON_EXTRACT(audience_members.details, '$.follower.id')) AS UNSIGNED))" : "jt.follower_id";
      const affiliateIdSelect = params.type === "affiliate" ? "max(affiliate_jt.affiliate_id)" : "max(jt.affiliate_id)";
      jsonFilterSql = json.toSql(`audience_members.*, max(jt.purchase_id) AS purchase_id, ${followerIdSelect} AS follower_id, ${affiliateIdSelect} AS affiliate_id`, true);
    } else if (json.conditions.length > baseScope.conditions.length) {
      jsonFilterSql = json.toSql();
    }
  }

  const subqueries = [typesSql, boughtUnion, notBoughtProductsSql, notBoughtVariantsSql, pricesSql, createdAtSql, countrySql, affiliatesSql, waitlistedSql, jsonFilterSql].filter((sql): sql is string => sql !== null);
  if (subqueries.length === 0) return { kind: "scope", where: baseScope.conditions.join(" AND ") };

  const joins = subqueries.slice(1).map((sql, index) => ` INNER JOIN (${sql}) AS q${index} ON audience_members.id = q${index}.id`).join("");
  let select: string | null = null;
  let distinct = false;
  if (jsonFilterSql !== null) {
    const jsonIndex = subqueries.slice(1).indexOf(jsonFilterSql);
    if (withIds && jsonIndex >= 0) {
      select = `audience_members.*, q${jsonIndex}.purchase_id AS purchase_id, q${jsonIndex}.follower_id AS follower_id, q${jsonIndex}.affiliate_id AS affiliate_id`;
    } else if (!withIds) {
      distinct = true;
    }
  }
  return { kind: "joined", from: subqueries[0]!, joins, select, distinct };
}

// Ruby truthiness of a normalized param: a present value (0 included), not nil or false.
const has = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

// `relation.to_sql`
export function audienceSql(relation: AudienceRelation): string {
  if (relation.kind === "scope") return `SELECT ${STAR} FROM ${AUDIENCE_MEMBERS} WHERE ${relation.where}`;
  return `SELECT ${relation.distinct ? "DISTINCT " : ""}${relation.select ?? STAR} FROM (${relation.from}) AS audience_members${relation.joins}`;
}

const ORDER_BY_ID = ` ORDER BY ${AUDIENCE_MEMBERS}.\`id\` ASC LIMIT 1`;

// `relation.first`
export function firstSql(relation: AudienceRelation): string {
  return `${audienceSql(relation)}${ORDER_BY_ID}`;
}

// `relation.count`, and `relation.limit(limit).count` (a subquery that counts the limited rows)
export function countSql(relation: AudienceRelation, limit: number | null = null): string {
  if (relation.kind === "scope") {
    if (limit === null) return `SELECT COUNT(*) FROM ${AUDIENCE_MEMBERS} WHERE ${relation.where}`;
    return `SELECT COUNT(*) FROM (SELECT 1 AS one FROM ${AUDIENCE_MEMBERS} WHERE ${relation.where} LIMIT ${limit}) subquery_for_count`;
  }
  const body = `FROM (${relation.from}) AS audience_members${relation.joins}`;
  if (limit === null) return relation.distinct ? `SELECT COUNT(DISTINCT ${AUDIENCE_MEMBERS}.\`id\`) ${body}` : `SELECT COUNT(*) ${body}`;
  return relation.distinct
    ? `SELECT COUNT(count_column) FROM (SELECT DISTINCT ${AUDIENCE_MEMBERS}.\`id\` AS count_column ${body} LIMIT ${limit}) subquery_for_count`
    : `SELECT COUNT(*) FROM (SELECT 1 AS one ${body} LIMIT ${limit}) subquery_for_count`;
}

export type AudienceMemberRow = {
  id: bigint | number;
  email: string;
  details: unknown;
  purchase_id?: number | null;
  follower_id?: number | null;
  affiliate_id?: number | null;
  [column: string]: unknown;
};

// `AudienceMember.filter(...).first`
export async function firstAudienceMember(sellerId: number, params: FilterParams, options: FilterOptions): Promise<AudienceMemberRow | null> {
  const [row] = await selectRows<AudienceMemberRow>(Prisma.raw(firstSql(filterAudience(sellerId, params, options))));
  return row ?? null;
}
