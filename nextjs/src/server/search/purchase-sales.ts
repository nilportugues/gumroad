// User#sales_cents_total (app/modules/user/stats.rb): revenue as a seller plus revenue as an
// affiliate, each an Elasticsearch aggregation over the purchases index built by
// PurchaseSearchService. The bodies follow its build order key for key, because the request bytes
// are part of what the golden pins (__fixtures__/sales-cents-total.golden.json).
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import type { JsonValue } from "./es-json.ts";

const SELLER_SUM_AGGS = [
  "price_cents",
  "fee_cents",
  "amount_refunded_cents",
  "fee_refunded_cents",
  "affiliate_credit_amount_cents",
  "affiliate_credit_amount_partially_refunded_cents",
  "direct_affiliate_credit_amount_cents",
  "direct_affiliate_credit_amount_partially_refunded_cents",
] as const;

// PurchaseSearchService::AFFILIATE_CREDIT_PREFIXES and AFFILIATE_CREDIT_MEASURES
const AFFILIATE_CREDIT_PREFIXES = ["affiliate_credit", "direct_affiliate_credit"] as const;
const AFFILIATE_CREDIT_MEASURES = ["amount_cents", "fee_cents", "amount_partially_refunded_cents", "fee_partially_refunded_cents"] as const;

type Aggregations = Record<string, { value?: number | null; total?: { value?: number | null } }>;

// The filters revenue_as_seller and revenue_as_affiliate share. `bool` keys appear in the order the
// service first touches them: filter, must_not, must.
function revenueBody(partyFilter: JsonValue, aggs: JsonValue, after: string | null): JsonValue {
  const state = { terms: { purchase_state: ["successful"] } };
  return {
    query: {
      bool: {
        filter: [...partyFilter as JsonValue[], { term: { stripe_refunded: false } }, { term: { not_chargedback_or_chargedback_reversed: true } }, state],
        must_not: [{ term: { selected_flags: "is_bundle_product_purchase" } }],
        must: [{ range: { price_cents: { gt: 0 } } }, ...(after === null ? [] : [{ range: { created_at: { gt: after } } }])],
      },
    },
    from: 0,
    size: 0,
    _source: false,
    aggs,
  };
}

// Ruby would raise NoMethodError on a nil aggregation value, so a missing one is an error here too.
function aggregationValue(value: number | null | undefined, name: string): number {
  if (typeof value !== "number") throw new TypeError("undefined method 'value' for nil");
  return value;
}

async function aggregations(body: JsonValue): Promise<Aggregations> {
  const response = await search({ index: indexName("Purchase"), body });
  // A response without aggregations reads as an empty Hashie::Mash, whose members are nil
  return (response.body as { aggregations?: Aggregations }).aggregations ?? {};
}

// User#revenue_as_seller
async function revenueAsSeller(userId: bigint, after: string | null): Promise<number> {
  const aggs = Object.fromEntries(SELLER_SUM_AGGS.map((field) => [`${field}_total`, { sum: { field } }]));
  const result = await aggregations(revenueBody([{ terms: { seller_id: [Number(userId)] } }], aggs, after));
  const value = (name: string) => aggregationValue(result[`${name}_total`]?.value, name);
  let total = 0;
  total += value("price_cents");
  total -= value("fee_cents");
  total -= value("amount_refunded_cents");
  total += value("fee_refunded_cents");
  total -= value("affiliate_credit_amount_cents");
  total += value("affiliate_credit_amount_partially_refunded_cents");
  total -= value("direct_affiliate_credit_amount_cents");
  total += value("direct_affiliate_credit_amount_partially_refunded_cents");
  return Math.trunc(total);
}

// PurchaseSearchService.affiliate_credit_aggs_for_user
function affiliateCreditAggs(userId: number): JsonValue {
  return Object.fromEntries(
    AFFILIATE_CREDIT_PREFIXES.flatMap((prefix) =>
      AFFILIATE_CREDIT_MEASURES.map((measure) => [
        `${prefix}_${measure}_own`,
        { filter: { term: { [`${prefix}_affiliate_user_id`]: userId } }, aggs: { total: { sum: { field: `${prefix}_${measure}` } } } },
      ]),
    ),
  );
}

// PurchaseSearchService.own_affiliate_credit_cents: each credit's sum is truncated on its own.
const ownAffiliateCreditCents = (result: Aggregations, measure: string) =>
  AFFILIATE_CREDIT_PREFIXES.reduce((sum, prefix) => sum + Math.trunc(aggregationValue(result[`${prefix}_${measure}_own`]?.total?.value, `${prefix}_${measure}_own`)), 0);

// User#revenue_as_affiliate
async function revenueAsAffiliate(userId: bigint, after: string | null): Promise<number> {
  const id = Number(userId);
  const affiliateFilter: JsonValue = {
    bool: {
      minimum_should_match: 1,
      should: [{ terms: { affiliate_credit_affiliate_user_id: [id] } }, { terms: { direct_affiliate_credit_affiliate_user_id: [id] } }],
    },
  };
  const result = await aggregations(revenueBody([affiliateFilter], affiliateCreditAggs(id), after));
  return Math.trunc(ownAffiliateCreditCents(result, "amount_cents") - ownAffiliateCreditCents(result, "amount_partially_refunded_cents"));
}

// User::MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT
export const MIN_SALES_CENTS_VALUE_FOR_STORE_AGENT = 10_000;

// User#sales_cents_total(after:), `after` being a Time: purchases created after it, as `created_at > after.iso8601`.
export async function salesCentsTotal(userId: bigint, { after = null }: { after?: Date | null } = {}): Promise<number> {
  const cutoff = after === null ? null : `${after.toISOString().slice(0, 19)}Z`;
  const asSeller = await revenueAsSeller(userId, cutoff);
  return asSeller + (await revenueAsAffiliate(userId, cutoff));
}
