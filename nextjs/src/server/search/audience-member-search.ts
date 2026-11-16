// AudienceMember::Searchable (app/models/concerns/audience_member/searchable.rb): the Elasticsearch query that mirrors
// AudienceMember.filter, and `filter_count`, which counts a seller's audience with it. Golden:
// __fixtures__/audience-member-filter-query.golden.json (scripts/golden/audience-member-filter-query.rb) pins the query for
// every param set the SQL golden covers.
import { Prisma } from "@prisma/client";

import { indexName } from "../infra/elasticsearch.ts";
import { countSql, filterAudience, normalizeFilterParams, type FilterParams } from "../models/audience-member.ts";
import { selectRows } from "../models/sql.ts";

import { count } from "./api.ts";
import type { JsonValue } from "./es-json.ts";

type Json = Record<string, JsonValue>;

const SINGLE_RECORD_DATE_FIELDS = {
  customer: ["purchase_created_at"],
  affiliate: ["affiliate_created_at"],
  follower: ["follower_created_at"],
} as const;

// After `normalize_filter_params` a key is either absent or holds a value Ruby treats as truthy (0 included).
const has = (params: FilterParams, key: keyof FilterParams): boolean =>
  params[key] !== undefined && params[key] !== null;

const boughtProductsOrVariantsQuery = (params: FilterParams): Json => {
  const bought: JsonValue[] = [];
  if (params.bought_product_ids) bought.push({ terms: { "purchases.product_id": params.bought_product_ids } });
  if (params.bought_variant_ids) bought.push({ terms: { "purchases.variant_ids": params.bought_variant_ids } });
  return { bool: { should: bought, minimum_should_match: 1 } };
};

const activeCustomersOnlyQuery = (): Json => ({
  bool: { must_not: [{ term: { "purchases.subscription_cancelled": true } }] },
});

// `minimum_license_uses.to_i`
const minimumLicenseUsesQuery = (value: number): Json => ({
  range: { "purchases.license_uses": { gte: Math.trunc(value) } },
});

function singleRecordDateFields(params: FilterParams): readonly string[] {
  if (params.type === "customer") return SINGLE_RECORD_DATE_FIELDS.customer;
  if (params.type === "follower") {
    return params.bought_product_ids || params.bought_variant_ids
      ? ["follower_created_at", "purchase_created_at"]
      : SINGLE_RECORD_DATE_FIELDS.follower;
  }
  if (params.type === "affiliate") return SINGLE_RECORD_DATE_FIELDS.affiliate;
  return ["purchase_created_at", "follower_created_at", "affiliate_created_at"];
}

// `filter_single_record_clause(params)`: filters combined must all match within one purchase, follower or affiliate record.
function singleRecordClause(params: FilterParams): Json | null {
  const purchaseDetailFilterPresent = (
    [
      "paid_more_than_cents",
      "paid_less_than_cents",
      "created_after",
      "created_before",
      "bought_from",
      "active_customers_only",
      "minimum_license_uses",
    ] as const
  ).some((key) => has(params, key));
  let singleRecordFiltering = Boolean(
    (params.bought_product_ids || params.bought_variant_ids || params.affiliate_product_ids) &&
      purchaseDetailFilterPresent,
  );
  singleRecordFiltering ||= has(params, "paid_more_than_cents") && has(params, "paid_less_than_cents");
  singleRecordFiltering ||= has(params, "created_after") && has(params, "created_before");
  singleRecordFiltering ||= has(params, "active_customers_only") || has(params, "minimum_license_uses");
  if (!singleRecordFiltering) return null;

  const hasPurchaseConditions = (
    [
      "bought_product_ids",
      "bought_variant_ids",
      "paid_more_than_cents",
      "paid_less_than_cents",
      "bought_from",
      "active_customers_only",
      "minimum_license_uses",
    ] as const
  ).some((key) => has(params, key));
  const hasAffiliateConditions = has(params, "affiliate_product_ids");
  const hasDateConditions = has(params, "created_after") || has(params, "created_before");
  const dateFields = singleRecordDateFields(params);
  const should: JsonValue[] = [];

  if (!hasAffiliateConditions && (!hasDateConditions || dateFields.includes("purchase_created_at"))) {
    const conditions: JsonValue[] = [];
    if (params.bought_product_ids || params.bought_variant_ids) conditions.push(boughtProductsOrVariantsQuery(params));
    if (has(params, "paid_more_than_cents"))
      conditions.push({ range: { "purchases.price_cents": { gt: params.paid_more_than_cents! } } });
    if (has(params, "paid_less_than_cents"))
      conditions.push({ range: { "purchases.price_cents": { lt: params.paid_less_than_cents! } } });
    if (has(params, "bought_from")) conditions.push({ term: { "purchases.country": params.bought_from! } });
    if (has(params, "active_customers_only")) conditions.push(activeCustomersOnlyQuery());
    if (has(params, "minimum_license_uses")) conditions.push(minimumLicenseUsesQuery(params.minimum_license_uses!));
    if (has(params, "created_after"))
      conditions.push({ range: { "purchases.created_at": { gt: params.created_after! } } });
    if (has(params, "created_before"))
      conditions.push({ range: { "purchases.created_at": { lt: params.created_before! } } });
    if (conditions.length > 0) should.push({ nested: { path: "purchases", query: { bool: { filter: conditions } } } });
  }

  if (
    !hasPurchaseConditions &&
    !hasAffiliateConditions &&
    hasDateConditions &&
    dateFields.includes("follower_created_at")
  ) {
    const conditions: JsonValue[] = [{ exists: { field: "follower_id" } }];
    if (has(params, "created_after"))
      conditions.push({ range: { follower_created_at: { gt: params.created_after! } } });
    if (has(params, "created_before"))
      conditions.push({ range: { follower_created_at: { lt: params.created_before! } } });
    should.push({ bool: { filter: conditions } });
  }

  if (
    !hasPurchaseConditions &&
    (!hasDateConditions || dateFields.includes("affiliate_created_at")) &&
    (hasAffiliateConditions || hasDateConditions)
  ) {
    const conditions: JsonValue[] = [];
    if (params.affiliate_product_ids)
      conditions.push({ terms: { "affiliates.product_id": params.affiliate_product_ids } });
    if (has(params, "created_after"))
      conditions.push({ range: { "affiliates.created_at": { gt: params.created_after! } } });
    if (has(params, "created_before"))
      conditions.push({ range: { "affiliates.created_at": { lt: params.created_before! } } });
    if (conditions.length > 0) should.push({ nested: { path: "affiliates", query: { bool: { filter: conditions } } } });
  }

  if (should.length === 0) return { match_none: {} };
  return { bool: { should, minimum_should_match: 1 } };
}

const CREATED_AT_FIELDS: Record<string, [string, string]> = {
  customer: ["min_purchase_created_at", "max_purchase_created_at"],
  follower: ["follower_created_at", "follower_created_at"],
  affiliate: ["min_affiliate_created_at", "max_affiliate_created_at"],
};

// `AudienceMember.filter_query(seller_id:, params:)`
export function filterQuery(sellerId: number | bigint, rawParams: FilterParams): JsonValue {
  const params = normalizeFilterParams(rawParams);
  const filter: JsonValue[] = [{ term: { seller_id: Number(sellerId) } }];
  const mustNot: JsonValue[] = [];

  if (params.type) filter.push({ term: { [params.type]: true } });
  if (params.bought_product_ids || params.bought_variant_ids)
    filter.push({ nested: { path: "purchases", query: boughtProductsOrVariantsQuery(params) } });
  if (params.not_bought_product_ids)
    mustNot.push({
      nested: { path: "purchases", query: { terms: { "purchases.product_id": params.not_bought_product_ids } } },
    });
  if (params.not_bought_variant_ids)
    mustNot.push({
      nested: { path: "purchases", query: { terms: { "purchases.variant_ids": params.not_bought_variant_ids } } },
    });
  // `email` is a keyword holding the downcased address, so the caller downcases the exclusion list.
  if (params.exclude_emails && params.exclude_emails.length > 0)
    mustNot.push({ terms: { email: params.exclude_emails } });
  if (params.include_emails && params.include_emails.length > 0)
    filter.push({ terms: { email: params.include_emails } });
  if (has(params, "paid_more_than_cents"))
    filter.push({ range: { max_paid_cents: { gt: params.paid_more_than_cents! } } });
  if (has(params, "paid_less_than_cents"))
    filter.push({ range: { min_paid_cents: { lt: params.paid_less_than_cents! } } });

  if (has(params, "created_after") || has(params, "created_before")) {
    const [minField, maxField] = CREATED_AT_FIELDS[params.type ?? ""] ?? ["min_created_at", "max_created_at"];
    if (has(params, "created_after")) filter.push({ range: { [maxField]: { gt: params.created_after! } } });
    if (has(params, "created_before")) filter.push({ range: { [minField]: { lt: params.created_before! } } });
  }

  if (has(params, "bought_from"))
    filter.push({ nested: { path: "purchases", query: { term: { "purchases.country": params.bought_from! } } } });
  if (has(params, "active_customers_only"))
    filter.push({ nested: { path: "purchases", query: activeCustomersOnlyQuery() } });
  if (has(params, "minimum_license_uses"))
    filter.push({ nested: { path: "purchases", query: minimumLicenseUsesQuery(params.minimum_license_uses!) } });
  if (params.affiliate_product_ids)
    filter.push({
      nested: { path: "affiliates", query: { terms: { "affiliates.product_id": params.affiliate_product_ids } } },
    });

  const singleRecord = singleRecordClause(params);
  if (singleRecord) filter.push(singleRecord);

  const bool: Json = { filter };
  if (mustNot.length > 0) bool.must_not = mustNot;
  return { bool };
}

// Ruby `present?` of a raw param: not nil, false, blank text or an empty collection.
const present = (value: unknown): boolean =>
  !(
    value === null ||
    value === undefined ||
    value === false ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );

// `AudienceMember.filter_count(seller_id:, params:, limit:)`: null where Elasticsearch's answer has no count.
export async function filterCount(
  sellerId: number | bigint | null,
  params: FilterParams = {},
  limit: number | null = null,
): Promise<number | null> {
  if (sellerId === null) return 0;
  // Licence uses and waitlists live outside the index, so those count through the SQL twin.
  if (present(params.minimum_license_uses) || present(params.waitlisted_product_ids)) {
    const [row] = await selectRows<Record<string, unknown>>(
      Prisma.raw(countSql(filterAudience(Number(sellerId), params), limit)),
    );
    return Number(Object.values(row ?? {})[0] ?? 0);
  }
  const response = await count({
    index: indexName("AudienceMember"),
    body: { query: filterQuery(sellerId, params) },
    ...(limit === null ? {} : { terminateAfter: limit }),
  });
  const value = (response.body as { count?: number }).count;
  return value === undefined ? null : value;
}
