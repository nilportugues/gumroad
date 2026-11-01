// PurchaseSearchService (app/services/purchase_search_service.rb): the filters behind the seller
// dashboard's customers and sales queries, the admin search and the library, as the request body Rails
// sends to the purchases index. The body is a plain Hash in Ruby (no DSL): `query.bool` takes its keys
// in the order the build touches them, then the native params follow. Proven by purchase-search.golden.json.
import { indexName } from "../infra/elasticsearch.ts";
import { search } from "./api.ts";
import { type JsonValue, timeAsJson } from "./es-json.ts";
import { arrayWrap, isHash, isNil, type Params, present, RubyError, rubyStrip, truthy } from "./ruby-params.ts";

// Mirrors the email analyzers' edge_ngram max_gram in Purchase::Searchable.
export const EMAIL_AUTOCOMPLETE_MAX_GRAM = 20;

// Purchase::ALL_SUCCESS_STATES
export const ALL_SUCCESS_STATES = ["preorder_authorization_successful", "successful", "not_charged", "gift_receiver_purchase_successful"] as const;

const DEFAULT_OPTIONS: Params = { from: 0, size: 5, sort: null, _source: false, aggs: {}, track_total_hits: null };

const LICENSE_KEY = /^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}$/u;
const QUOTED = /^"([^\n]*)"$/u;

type Clause = { [key: string]: JsonValue };
type BoolKey = "filter" | "must" | "must_not";
const asJson = (value: unknown): JsonValue => value as JsonValue;

// A record passed where an id is expected (a User, Link, BaseVariant, Purchase or Taxonomy) is read by its id.
const idOf = (value: unknown): unknown => (isHash(value) && "id" in value ? value.id : value);
const ids = (value: unknown): JsonValue => arrayWrap(value).map((entry) => asJson(idOf(entry))) as JsonValue;

// Time#iso8601 for a UTC time.
function iso8601(value: unknown): string {
  if (!(value instanceof Date)) throw new RubyError("NoMethodError", "undefined method 'iso8601' for a non-Time value");
  return `${timeAsJson(value)}`;
}

export type PurchaseSearchBody = {
  query: { bool: Partial<Record<BoolKey, Clause[]>> };
  [native: string]: JsonValue | { bool: Partial<Record<BoolKey, Clause[]>> } | undefined;
};

export class PurchaseSearchService {
  readonly options: Params;
  readonly body: PurchaseSearchBody;
  private fulltextClauseIndex: number | null = null;

  constructor(options: Params = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.applyForLibrary();
    this.body = { query: { bool: {} } };
    this.build();
  }

  private get bool() {
    return this.body.query.bool;
  }

  // Hash.new { |hash, key| hash[key] = [] }: a key exists once something is pushed (or read).
  private list(key: BoolKey): Clause[] {
    return (this.bool[key] ??= []);
  }

  private applyForLibrary(): void {
    if (!truthy(this.options.for_library)) return;
    Object.assign(this.options, {
      state: [...ALL_SUCCESS_STATES],
      exclude_additional_contributions: true,
      exclude_non_original_subscription_purchases: true,
      exclude_deactivated_subscriptions: true,
      exclude_gifters: true,
      exclude_refunded_except_subscriptions: true,
      exclude_unreversed_chargedback: true,
      exclude_bundle_product_purchases: true,
      exclude_commission_completion_purchases: true,
      exclude_access_revoked: true,
      exclude_deleted_by_buyer: true,
    });
  }

  private flag(name: string): boolean {
    return truthy(this.options[name]);
  }

  private build(): void {
    const o = this.options;
    const blank = (name: string) => !present(o[name]);

    if (!blank("seller")) this.list("filter").push({ terms: { seller_id: ids(o.seller) } });
    if (!blank("purchaser")) this.list("filter").push({ terms: { purchaser_id: ids(o.purchaser) } });
    if (!blank("id")) this.list("filter").push({ terms: { id: asJson(arrayWrap(o.id)) } });
    if (!blank("product")) this.list("filter").push({ terms: { product_id: ids(o.product) } });
    this.buildBuyerSearch();
    for (const product of arrayWrap(o.exclude_product)) this.list("must_not").push({ term: { product_id: asJson(idOf(product)) } });
    for (const product of arrayWrap(o.exclude_purchasers_of_product)) {
      this.list("must_not").push({ term: { product_ids_from_same_seller_purchased_by_purchaser: asJson(idOf(product)) } });
    }
    if (!blank("variant")) this.list("filter").push({ terms: { variant_ids: ids(o.variant) } });
    for (const variant of arrayWrap(o.exclude_variant)) this.list("must_not").push({ term: { variant_ids: asJson(idOf(variant)) } });
    for (const variant of arrayWrap(o.exclude_purchasers_of_variant)) {
      this.list("must_not").push({ term: { variant_ids_from_same_seller_purchased_by_purchaser: asJson(idOf(variant)) } });
    }
    for (const purchase of arrayWrap(o.exclude_purchase)) this.list("must_not").push({ term: { id: asJson(idOf(purchase)) } });
    this.buildAnyProductsOrVariants();
    if (!blank("affiliate_user")) {
      const userIds = ids(o.affiliate_user);
      this.list("filter").push({
        bool: { minimum_should_match: 1, should: [{ terms: { affiliate_credit_affiliate_user_id: userIds } }, { terms: { direct_affiliate_credit_affiliate_user_id: userIds } }] },
      });
    }
    if (!blank("revenue_sharing_user")) {
      const userIds = ids(o.revenue_sharing_user);
      this.list("filter").push({
        bool: {
          minimum_should_match: 1,
          should: [{ terms: { affiliate_credit_affiliate_user_id: userIds } }, { terms: { direct_affiliate_credit_affiliate_user_id: userIds } }, { terms: { seller_id: userIds } }],
        },
      });
    }
    if (!blank("taxonomy")) this.list("filter").push({ terms: { taxonomy_id: ids(o.taxonomy) } });

    if (this.flag("exclude_refunded")) this.list("filter").push({ term: { stripe_refunded: false } });
    if (this.flag("exclude_refunded_except_subscriptions")) this.list("filter").push({ term: { not_refunded_except_subscriptions: true } });
    if (this.flag("exclude_unreversed_chargedback")) this.list("filter").push({ term: { not_chargedback_or_chargedback_reversed: true } });
    if (this.flag("exclude_non_original_subscription_purchases")) this.list("filter").push({ term: { not_subscription_or_original_subscription_purchase: true } });
    if (this.flag("exclude_not_charged_non_free_trial_purchases")) {
      this.list("must_not").push({
        bool: { must: [{ term: { purchase_state: "not_charged" } }, { bool: { must_not: [{ term: { selected_flags: "is_free_trial_purchase" } }] } }] },
      });
    }
    if (this.flag("exclude_deactivated_subscriptions")) this.list("must_not").push({ exists: { field: "subscription_deactivated_at" } });
    if (this.flag("exclude_cancelled_or_pending_cancellation_subscriptions")) this.list("must_not").push({ exists: { field: "subscription_cancelled_at" } });
    if (this.flag("exclude_cant_contact")) this.list("filter").push({ term: { can_contact: true } });
    if (this.flag("exclude_giftees")) this.list("must_not").push({ term: { selected_flags: "is_gift_receiver_purchase" } });
    if (this.flag("exclude_gifters")) this.list("must_not").push({ term: { selected_flags: "is_gift_sender_purchase" } });
    if (this.flag("exclude_non_successful_preorder_authorizations")) this.list("filter").push({ term: { successful_authorization_or_without_preorder: true } });
    if (this.flag("exclude_bundle_product_purchases")) this.list("must_not").push({ term: { selected_flags: "is_bundle_product_purchase" } });
    if (this.flag("exclude_commission_completion_purchases")) this.list("must_not").push({ term: { selected_flags: "is_commission_completion_purchase" } });
    if (this.flag("exclude_deleted_by_buyer")) this.list("must_not").push({ term: { selected_flags: "is_deleted_by_buyer" } });
    if (this.flag("exclude_additional_contributions")) this.list("must_not").push({ term: { selected_flags: "is_additional_contribution" } });
    if (this.flag("exclude_access_revoked")) this.list("must_not").push({ term: { selected_flags: "is_access_revoked" } });

    if (this.flag("price_greater_than")) this.list("must").push({ range: { price_cents: { gt: asJson(o.price_greater_than) } } });
    if (this.flag("price_less_than")) this.list("must").push({ range: { price_cents: { lt: asJson(o.price_less_than) } } });
    if (!isNil(o.license_uses_greater_than_or_equal_to)) {
      this.list("must").push({ range: { license_uses: { gte: asJson(o.license_uses_greater_than_or_equal_to) } } });
    }
    for (const [name, operator] of [["created_after", "gt"], ["created_on_or_after", "gte"], ["created_before", "lt"], ["created_on_or_before", "lte"]] as const) {
      if (this.flag(name)) this.list("must").push({ range: { created_at: { [operator]: iso8601(o[name]) } } });
    }

    if (this.flag("country")) this.list("filter").push({ terms: { country_or_ip_country: asJson(arrayWrap(o.country)) } });
    if (this.flag("email")) {
      if (typeof o.email !== "string") throw new RubyError("NoMethodError", "undefined method 'downcase'");
      this.list("filter").push({ term: { "email.raw": o.email.toLowerCase() } });
    }
    if (this.flag("state")) this.list("filter").push({ terms: { purchase_state: asJson(arrayWrap(o.state)) } });
    if (!isNil(o.archived)) this.list(truthy(o.archived) ? "must" : "must_not").push({ term: { selected_flags: "is_archived" } });
    if (!isNil(o.recommended)) this.list(truthy(o.recommended) ? "must" : "must_not").push({ term: { selected_flags: "was_product_recommended" } });

    this.buildFulltextSearch();
    this.buildNativeParams();
  }

  private buildAnyProductsOrVariants(): void {
    const spec = this.options.any_products_or_variants;
    if (!present(spec)) return;
    const wanted = spec as Record<string, unknown>;
    const should: Clause[] = [];
    if (present(wanted.products)) should.push({ terms: { product_id: ids(wanted.products) } });
    if (present(wanted.variants)) should.push({ terms: { variant_ids: ids(wanted.variants) } });
    if (should.length === 0) return;
    this.list("filter").push({ bool: { minimum_should_match: 1, should } });
  }

  private buildBuyerSearch(): void {
    if (!present(this.options.buyer_query)) return;
    const query = rubyStrip(String(this.options.buyer_query)).toLowerCase();
    this.list("must").push({ multi_match: { query, fields: ["product_name", "product_description", "seller_name"] } });
  }

  private buildFulltextSearch(): void {
    if (!present(this.options.seller_query)) return;
    const query = rubyStrip(String(this.options.seller_query)).toLowerCase();
    const should: Clause[] = [];
    const quoted = QUOTED.exec(query);
    if (quoted) {
      should.push({ multi_match: { query: quoted[1]!, fields: ["full_name"], operator: "and" } });
    } else {
      should.push({ multi_match: { query, fields: ["email", "email_domain", "full_name", "subscription_current_email", "subscription_current_email_domain"] } });
      if (query.includes("@")) {
        should.push({ term: { "email.raw": query } }, { term: { "subscription_current_email.raw": query } }, { term: { "paypal_email.raw": query } });
      }
      if (LICENSE_KEY.test(query)) should.push({ term: { license_serial: query.toUpperCase() } });
    }
    this.fulltextClauseIndex = this.list("must").length;
    this.list("must").push({ bool: { minimum_should_match: 1, should } });
  }

  private buildNativeParams(): void {
    for (const name of ["from", "size", "sort", "_source", "aggs", "track_total_hits"]) {
      const value = this.options[name];
      if (isNil(value)) continue;
      this.body[name] = asJson(value);
    }
  }

  // A token past the gram window matches no indexed term.
  private longQueryTokens(): string[] {
    const query = rubyStrip(this.options.seller_query === undefined || this.options.seller_query === null ? "" : String(this.options.seller_query)).toLowerCase();
    return query.split(/[\t\n\v\f\r ]+/u).filter((token) => token !== "" && [...token].length > EMAIL_AUTOCOMPLETE_MAX_GRAM);
  }

  // Added only after the query above matched nothing.
  private fallbackBody(tokens: string[]): PurchaseSearchBody {
    const body = structuredClone(this.body);
    const clause = body.query.bool.must![this.fulltextClauseIndex!] as { bool: { should: Clause[] } };
    for (const token of tokens) {
      clause.bool.should.push({ prefix: { "email.raw": token } }, { prefix: { "subscription_current_email.raw": token } }, { prefix: { "paypal_email.raw": token } });
    }
    return body;
  }

  // PurchaseSearchService#process
  async process(): Promise<PurchaseSearchResult> {
    const response = await run(this.body);
    if (!present(this.options.seller_query) || sellerQueryMatched(response)) return response;
    const tokens = this.longQueryTokens();
    if (tokens.length === 0 || this.fulltextClauseIndex === null) return response;
    return run(this.fallbackBody(tokens));
  }

  static process(options: Params = {}): Promise<PurchaseSearchResult> {
    return new PurchaseSearchService(options).process();
  }
}

export type PurchaseSearchResult = {
  // hits.total.value; null when track_total_hits is false.
  total: number | null;
  // The hits' _id, in result order.
  ids: string[];
  response: { hits?: { total?: number | { value: number }; hits?: Array<{ _id: string }> }; aggregations?: Record<string, unknown> };
};

async function run(body: PurchaseSearchBody): Promise<PurchaseSearchResult> {
  const { body: data } = await search({ index: indexName("Purchase"), body: body as unknown as JsonValue });
  const response = data as PurchaseSearchResult["response"];
  const total = response.hits?.total;
  return {
    total: total === undefined ? null : typeof total === "number" ? total : total.value,
    ids: (response.hits?.hits ?? []).map((hit) => hit._id),
    response,
  };
}

// A nil total means the caller passed track_total_hits: false, so the response cannot say whether the
// query matched; widening a result set that cannot be read is worse than leaving it alone.
const sellerQueryMatched = (result: PurchaseSearchResult): boolean => result.total === null || result.total > 0;
