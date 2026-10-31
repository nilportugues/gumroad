// Product::Searchable#as_indexed_json / #build_search_update (app/modules/product/searchable.rb)
// and the link.rb, prices.rb, stats.rb, recommendations.rb, user.rb and taxonomy_attribute.rb reads
// they make, statement for statement. Reads go through the query cache (query-cache.ts) as they do
// under the Rails executor; an association is loaded once per record, a relation on every call.
import { Prisma } from "@prisma/client";

import { userActor } from "../../infra/flipper.ts";
import { isAdult } from "../../models/concerns/adult-keyword-detector.ts";
import { ago } from "../../models/concerns/ruby-time.ts";
import { isStripeConnectAccount, type MerchantAccountRow } from "../../models/merchant-account.ts";
import { castRow } from "../../models/sql.ts";
import type { Row } from "../../models/runtime/record.ts";
import approximations from "../../infra/i18n-approximations.json" with { type: "json" };
import { search } from "../api.ts";
import { indexName } from "../../infra/elasticsearch.ts";
import { type JsonValue, RubyFloat, timeAsJson } from "../es-json.ts";
import { cachedSelect } from "../query-cache.ts";
import { isBlank, jsonColumn } from "../rows.ts";

// Product::Searchable::SEARCH_FIELDS, in the order as_indexed_json writes them.
export const PRODUCT_SEARCH_FIELDS = [
  "user_id", "is_physical", "tags", "creator_name", "sales_volume", "created_at", "average_rating", "reviews_count",
  "is_subscription", "is_bundle", "filetypes", "price_cents", "available_price_cents", "updated_at", "creator_external_id",
  "content_updated_at", "total_fee_cents", "past_year_fee_cents", "staff_picked_at", "offer_codes", "taxonomy_attribute_filters",
  "name", "rated_as_adult", "description", "is_recommendable", "is_alive_on_profile", "is_alive", "taxonomy_id", "is_preorder",
  "display_product_reviews", "is_call", "native_type", "price_currency_type", "customizable_price",
] as const;

// Product::Searchable::ATTRIBUTE_TO_SEARCH_FIELDS_MAP: the Link columns whose change reindexes these fields.
export const PRODUCT_ATTRIBUTE_TO_SEARCH_FIELDS: Record<string, string | string[]> = {
  name: ["name", "rated_as_adult"],
  description: ["description", "rated_as_adult"],
  price_cents: ["price_cents", "available_price_cents"],
  purchase_disabled_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  deleted_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  banned_at: ["is_recommendable", "is_alive_on_profile", "is_alive"],
  max_purchase_count: ["is_recommendable"],
  taxonomy_id: ["taxonomy_id", "taxonomy_attribute_filters", "is_recommendable"],
  content_updated_at: "content_updated_at",
  archived: ["is_recommendable", "is_alive_on_profile"],
  is_in_preorder_state: "is_preorder",
  display_product_reviews: ["display_product_reviews", "is_recommendable"],
  is_adult: "rated_as_adult",
  native_type: ["is_call", "native_type"],
  is_bundle: "is_bundle",
  price_currency_type: "price_currency_type",
  customizable_price: "customizable_price",
};

const MAX_OFFER_CODES_IN_INDEX = 300;
const DEFAULT_SALES_VOLUME_RECENTNESS = { months: 3 };
const PAST_YEAR = { years: 1 };
const NATIVE_TYPE_CALL = "call";
const CLOSE_TO_NEW_BUYERS_FEATURE = "close_membership_tier_to_new_buyers";
// Link enums, by stored integer.
const PURCHASE_TYPES = ["buy_only", "rent_only", "buy_and_rent"];
const SUBSCRIPTION_DURATIONS = ["monthly", "yearly", "quarterly", "biannually", "every_two_years"];
// Purchase::CHARGED_SALES_SEARCH_OPTIONS[:state]: CHARGED_SUCCESS_STATES + preorder_concluded_successfully.
const CHARGED_SALES_STATES = ["preorder_authorization_successful", "successful", "preorder_concluded_successfully"];

// has_flags bit positions (Link, User, BasePrice, BaseVariant).
const LINK_FLAG = { is_recurring_billing: 2, is_in_preorder_state: 4, archived: 5, is_physical: 8, is_adult: 16, display_product_reviews: 17, is_tiered_membership: 19, is_bundle: 26 };
const USER_ALL_ADULT_PRODUCTS = 32;
const PRICE_IS_RENTAL = 1;
const VARIANT_CLOSED_TO_NEW_PURCHASES = 3;

const flag = (flags: unknown, position: number) => (BigInt((flags as bigint | number | null) ?? 0) & (1n << BigInt(position - 1))) !== 0n;

export class ProductSearchPropertyError extends Error {
  constructor(attribute: string) {
    super(`Error building search properties. ${attribute} is not a valid property`);
    this.name = "RuntimeError";
  }
}

class NoMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMethodError";
  }
}

export type ProductDocumentDeps = {
  // Time.current
  now: () => Date;
  // Feature.active?(name, user)
  featureActive: (name: string, actor: string) => Promise<boolean>;
};

const raw = Prisma.raw;
const idOf = (row: Row) => row.id as bigint;

// MySQL renders a FLOAT column with the fewest digits that read back as the same single, and
// mysql2 parses that text; the driver here hands over the single widened to a double.
function mysqlFloat(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  const single = Math.fround(n);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(n.toPrecision(digits));
    if (Math.fround(candidate) === single) return candidate;
  }
  return n;
}

// I18n.transliterate (ActiveSupport::Inflector.transliterate normalizes to NFC first).
function transliterate(value: string): string {
  const table = approximations as Record<string, string>;
  return value.normalize("NFC").replace(/[^\x00-\x7f]/gu, (char) => table[char] ?? "?");
}

// String#parameterize(separator: "_").
function parameterizeUnderscore(value: string): string {
  return transliterate(value)
    .replace(/[^a-z0-9\-_]+/giu, "_")
    .replace(/_{2,}/gu, "_")
    .replace(/^_|_$/gmu, "")
    .toLowerCase();
}

// Object#to_s for a value read out of json_data.
function rubyToS(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof RubyFloat) return Number.isInteger(value.value) ? `${value.value}.0` : String(value.value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// ActiveModel::Type::Boolean#cast's FALSE_VALUES (the symbols cannot come out of JSON).
const FALSE_VALUES = new Set<unknown>([false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]);

// TaxonomyAttribute#filter_token_for
function filterTokenFor(attribute: Row, value: unknown): string | null {
  let normalized: string | null = null;
  switch (attribute.value_type) {
    case "enum": {
      const options = (() => {
        const values = jsonColumn(attribute.values);
        if (values === null) return [];
        return (Array.isArray(values) ? values : [values]).map(rubyToS);
      })();
      const text = rubyToS(value);
      normalized = options.includes(text) ? text : null;
      break;
    }
    case "boolean":
      if (value !== null && value !== undefined && value !== "") normalized = String(!FALSE_VALUES.has(value instanceof RubyFloat ? value.value : value));
      break;
    // "number" is not filterable, so its normalized value never makes a token.
  }
  if (normalized === null || isBlank(normalized) || !["enum", "boolean"].includes(String(attribute.value_type))) return null;
  return `${String(attribute.name)}:${parameterizeUnderscore(normalized)}`;
}

// `json_data` through Link's JSON coder: a blank column reads as nil.
function linkJsonData(value: unknown): Record<string, JsonValue> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const data = jsonColumn(value);
  return data !== null && typeof data === "object" && !Array.isArray(data) && !(data instanceof RubyFloat) ? (data as Record<string, JsonValue>) : null;
}

const findRow = async (model: Prisma.ModelName, table: string, id: unknown): Promise<Row | null> => {
  const [row] = await cachedSelect<Row>(Prisma.sql`SELECT ${raw(`\`${table}\`.*`)} FROM ${raw(`\`${table}\``)} WHERE ${raw(`\`${table}\`.\`id\``)} = ${id} LIMIT 1`);
  return row ? castRow(model, row) : null;
};

// PurchaseSearchService.search(Purchase::CHARGED_SALES_SEARCH_OPTIONS.merge(product:, size: 0,
// aggs:, created_after:)): the body that combination builds.
function chargedSalesBody(productId: bigint, createdAfter: Date, aggs: Record<string, string>): JsonValue {
  return {
    query: {
      bool: {
        filter: [
          { terms: { product_id: [productId] } },
          { term: { stripe_refunded: false } },
          { term: { not_chargedback_or_chargedback_reversed: true } },
          { term: { successful_authorization_or_without_preorder: true } },
          { terms: { purchase_state: CHARGED_SALES_STATES } },
        ],
        must_not: [
          { term: { selected_flags: "is_gift_receiver_purchase" } },
          { term: { selected_flags: "is_bundle_product_purchase" } },
          { term: { selected_flags: "is_commission_completion_purchase" } },
        ],
        must: [{ range: { created_at: { gt: timeAsJson(createdAfter) } } }],
      },
    },
    from: 0,
    size: 0,
    _source: false,
    aggs: Object.fromEntries(Object.entries(aggs).map(([name, field]) => [name, { sum: { field } }])),
  };
}

// `aggregations.<a>.value - aggregations.<b>.value`. Sum aggregations are doubles, so Ruby gets Floats.
async function aggregateDifference(productId: bigint, createdAfter: Date, total: [string, string], refunded: [string, string]): Promise<RubyFloat> {
  const response = await search({ index: indexName("Purchase"), body: chargedSalesBody(productId, createdAfter, Object.fromEntries([total, refunded])) });
  const aggregations = (response.body as { aggregations?: Record<string, { value: unknown }> } | null)?.aggregations;
  const value = (name: string) => {
    const agg = aggregations?.[name];
    if (!agg) throw new NoMethodError(`undefined method 'value' for nil`);
    const v = agg.value;
    return v instanceof RubyFloat ? v.value : Number(v);
  };
  return new RubyFloat(value(total[0]) - value(refunded[0]));
}

export class ProductRecord {
  readonly row: Row;
  private readonly deps: ProductDocumentDeps;
  private userMemo?: Promise<Row | null>;
  private reviewStatMemo?: Promise<Row | null>;
  private staffPickMemo?: Promise<Row | null>;
  private taxonomyMemo?: Promise<Row | null>;
  private taxonomyAttributesMemo?: Promise<Row[]>;

  constructor(row: Row, deps: ProductDocumentDeps) {
    this.row = row;
    this.deps = deps;
  }

  // Link.find_by(id:)
  static async find(id: unknown, deps: ProductDocumentDeps): Promise<ProductRecord | null> {
    const row = await findRow("Link", "links", id);
    return row ? new ProductRecord(row, deps) : null;
  }

  get id(): bigint {
    return idOf(this.row);
  }

  private get flags() {
    return this.row.flags;
  }

  private get purchaseType() {
    return PURCHASE_TYPES[Number(this.row.purchase_type)] ?? null;
  }

  user(): Promise<Row | null> {
    this.userMemo ??= this.row.user_id == null ? Promise.resolve(null) : findRow("User", "users", this.row.user_id);
    return this.userMemo;
  }

  private async requireUser(method: string): Promise<Row> {
    const user = await this.user();
    if (!user) throw new NoMethodError(`undefined method '${method}' for nil`);
    return user;
  }

  // belongs_to :taxonomy
  private taxonomy(): Promise<Row | null> {
    this.taxonomyMemo ??= this.row.taxonomy_id == null ? Promise.resolve(null) : findRow("Taxonomy", "taxonomies", this.row.taxonomy_id);
    return this.taxonomyMemo;
  }

  get alive(): boolean {
    return this.row.purchase_disabled_at == null && this.row.banned_at == null && this.row.deleted_at == null;
  }

  // Product::Searchable#build_search_update
  async buildSearchUpdate(attributeNames: readonly JsonValue[]): Promise<Record<string, JsonValue>> {
    const attributes: Record<string, JsonValue> = {};
    for (const name of attributeNames) {
      for (const attribute of Array.isArray(name) ? name : name === null ? [] : [name]) {
        attributes[String(attribute)] = await this.searchProperty(String(attribute));
      }
    }
    return attributes;
  }

  asIndexedJson(): Promise<Record<string, JsonValue>> {
    return this.buildSearchUpdate(PRODUCT_SEARCH_FIELDS);
  }

  private async searchProperty(key: string): Promise<JsonValue> {
    const row = this.row;
    switch (key) {
      case "name":
        return row.name as JsonValue;
      case "description":
        return row.description as JsonValue;
      case "tags":
        return (
          await cachedSelect<{ name: string }>(
            Prisma.sql`SELECT \`tags\`.\`name\` FROM \`tags\` INNER JOIN \`product_taggings\` ON \`tags\`.\`id\` = \`product_taggings\`.\`tag_id\` WHERE \`product_taggings\`.\`product_id\` = ${this.id} ORDER BY \`product_taggings\`.\`tag_id\` ASC`,
          )
        ).map((tag) => tag.name);
      case "creator_name": {
        const user = await this.requireUser("name");
        return (user.name ?? username(user)) as JsonValue;
      }
      case "sales_volume":
        return aggregateDifference(this.id, ago(DEFAULT_SALES_VOLUME_RECENTNESS, this.deps.now()), ["price_cents_total", "price_cents"], ["amount_refunded_cents_total", "amount_refunded_cents"]);
      case "is_recommendable":
        return this.isRecommendable();
      case "rated_as_adult":
        return this.ratedAsAdult();
      case "created_at":
        return timeAsJson(row.created_at as Date | null);
      case "average_rating": {
        const stat = await this.reviewStat();
        return new RubyFloat(stat ? mysqlFloat(stat.average_rating) : 0);
      }
      case "reviews_count": {
        const stat = await this.reviewStat();
        return stat ? (stat.reviews_count as JsonValue) : 0;
      }
      case "price_cents":
        return this.defaultPriceCents();
      case "available_price_cents":
        return this.discoverPriceCents();
      case "is_physical":
        return flag(this.flags, LINK_FLAG.is_physical);
      case "is_subscription":
        return flag(this.flags, LINK_FLAG.is_recurring_billing);
      case "is_bundle":
        return flag(this.flags, LINK_FLAG.is_bundle);
      case "is_preorder":
        return flag(this.flags, LINK_FLAG.is_in_preorder_state);
      case "filetypes":
        return [
          ...new Set(
            (
              await cachedSelect<{ filetype: string | null }>(
                Prisma.sql`SELECT \`product_files\`.\`filetype\` FROM \`product_files\` WHERE \`product_files\`.\`link_id\` = ${this.id} AND \`product_files\`.\`deleted_at\` IS NULL`,
              )
            ).map((file) => file.filetype),
          ),
        ];
      case "user_id":
        return row.user_id as JsonValue;
      case "taxonomy_id":
        return row.taxonomy_id as JsonValue;
      case "is_alive_on_profile":
        return this.alive && !flag(this.flags, LINK_FLAG.archived);
      case "is_alive":
        return this.alive;
      case "is_call":
        return row.native_type === NATIVE_TYPE_CALL;
      case "native_type":
        return row.native_type as JsonValue;
      case "customizable_price":
        return row.customizable_price === true;
      case "price_currency_type":
        return row.price_currency_type as JsonValue;
      case "display_product_reviews":
        return flag(this.flags, LINK_FLAG.display_product_reviews);
      case "updated_at":
        return timeAsJson(row.updated_at as Date | null);
      case "creator_external_id":
        return (await this.requireUser("external_id")).external_id as JsonValue;
      case "content_updated_at":
        return timeAsJson(row.content_updated_at as Date | null);
      case "total_fee_cents":
        return aggregateDifference(this.id, ago(DEFAULT_SALES_VOLUME_RECENTNESS, this.deps.now()), ["fee_cents_total", "fee_cents"], ["fee_refunded_cents_total", "fee_refunded_cents"]);
      case "past_year_fee_cents":
        return aggregateDifference(this.id, ago(PAST_YEAR, this.deps.now()), ["fee_cents_total", "fee_cents"], ["fee_refunded_cents_total", "fee_refunded_cents"]);
      case "staff_picked_at": {
        const pick = await this.staffPick();
        return pick && pick.deleted_at == null ? timeAsJson(pick.updated_at as Date) : null;
      }
      case "offer_codes":
        return (await this.productAndUniversalOfferCodes()).slice(-MAX_OFFER_CODES_IN_INDEX).map((code) => code.code as JsonValue);
      case "taxonomy_attribute_filters":
        return this.taxonomyAttributeFilterTokens();
      default:
        throw new ProductSearchPropertyError(key);
    }
  }

  private reviewStat(): Promise<Row | null> {
    this.reviewStatMemo ??= cachedSelect<Row>(
      Prisma.sql`SELECT \`product_review_stats\`.* FROM \`product_review_stats\` WHERE \`product_review_stats\`.\`link_id\` = ${this.id} LIMIT 1`,
    ).then(([stat]) => (stat ? castRow("ProductReviewStat", stat) : null));
    return this.reviewStatMemo;
  }

  private staffPick(): Promise<Row | null> {
    this.staffPickMemo ??= cachedSelect<Row>(
      Prisma.sql`SELECT \`staff_picked_products\`.* FROM \`staff_picked_products\` WHERE \`staff_picked_products\`.\`product_id\` = ${this.id} LIMIT 1`,
    ).then(([pick]) => (pick ? castRow("StaffPickedProduct", pick) : null));
    return this.staffPickMemo;
  }

  // Product::Prices#prices_for_currency: `alive_prices.where(currency: price_currency_type)`.
  private async pricesForCurrency(): Promise<Row[]> {
    const rows = await cachedSelect<Row>(
      Prisma.sql`SELECT \`prices\`.* FROM \`prices\` WHERE \`prices\`.\`link_id\` = ${this.id} AND \`prices\`.\`deleted_at\` IS NULL AND \`prices\`.\`currency\` = ${this.row.price_currency_type}`,
    );
    return rows.map((price) => castRow("BasePrice", price));
  }

  private async defaultPrice(): Promise<Row | null> {
    const prices = await this.pricesForCurrency();
    if (this.purchaseType === "rent_only") return prices.filter((price) => flag(price.flags, PRICE_IS_RENTAL)).at(-1) ?? null;
    let relevant = prices.filter((price) => !flag(price.flags, PRICE_IS_RENTAL));
    const duration = this.row.subscription_duration == null ? null : SUBSCRIPTION_DURATIONS[Number(this.row.subscription_duration)];
    if (flag(this.flags, LINK_FLAG.is_recurring_billing) && duration) relevant = relevant.filter((price) => price.recurrence === duration);
    return relevant.at(-1) ?? null;
  }

  // Product::Prices#default_price_cents (aliased as price_cents).
  private async defaultPriceCents(): Promise<number | null> {
    if (this.purchaseType === "rent_only") {
      const prices = await this.pricesForCurrency();
      const rental = prices.filter((price) => flag(price.flags, PRICE_IS_RENTAL)).at(-1);
      return rental ? (rental.price_cents as number) : null;
    }
    if (this.purchaseType !== "buy_only" && this.purchaseType !== "buy_and_rent") return null;
    const price = await this.defaultPrice();
    return price ? (price.price_cents as number) : null;
  }

  // Link#current_base_variants: `link_id = ? OR variant_category_id IN (?)`, whose binds Rails 8
  // quotes as strings, and an empty list as NULL.
  private async currentBaseVariants(select: "*" | "price_difference_cents"): Promise<Row[]> {
    const categoryIds = (
      await cachedSelect<{ id: unknown }>(
        Prisma.sql`SELECT \`variant_categories\`.\`id\` FROM \`variant_categories\` WHERE \`variant_categories\`.\`link_id\` = ${this.id} AND \`variant_categories\`.\`deleted_at\` IS NULL`,
      )
    ).map((category) => String(category.id));
    const list = categoryIds.length === 0 ? raw("NULL") : Prisma.join(categoryIds, ", ");
    const columns = raw(select === "*" ? "`base_variants`.*" : "`base_variants`.`price_difference_cents`");
    return cachedSelect<Row>(
      Prisma.sql`SELECT ${columns} FROM \`base_variants\` WHERE \`base_variants\`.\`deleted_at\` IS NULL AND (link_id = ${String(this.id)} OR variant_category_id IN (${list}))`,
    );
  }

  // Product::Prices#available_price_cents, for a product that is not a tiered membership.
  private async availablePriceCents(): Promise<(number | null)[]> {
    let prices: (number | null)[];
    if ((await this.currentBaseVariants("*")).length > 0) {
      const base = await this.defaultPriceCents();
      prices = (await this.currentBaseVariants("price_difference_cents")).map((variant) => {
        if (base === null) throw new NoMethodError("undefined method '+' for nil");
        return base + Number(variant.price_difference_cents ?? 0);
      });
    } else if (this.purchaseType === "rent_only") {
      prices = (
        await cachedSelect<{ price_cents: number }>(
          Prisma.sql`SELECT \`prices\`.\`price_cents\` FROM \`prices\` WHERE \`prices\`.\`link_id\` = ${this.id} AND \`prices\`.\`deleted_at\` IS NULL AND ((\`prices\`.\`flags\` & 1 = 1)) AND \`prices\`.\`currency\` = ${this.row.price_currency_type}`,
        )
      ).map((price) => price.price_cents);
    } else {
      prices = (
        await cachedSelect<{ price_cents: number }>(
          Prisma.sql`SELECT \`prices\`.\`price_cents\` FROM \`prices\` WHERE \`prices\`.\`link_id\` = ${this.id} AND \`prices\`.\`deleted_at\` IS NULL AND ((\`prices\`.\`flags\` & 1 = 0))`,
        )
      ).map((price) => price.price_cents);
    }
    return [...new Set(prices)];
  }

  // Product::Prices#discover_price_cents
  private async discoverPriceCents(): Promise<(number | null)[]> {
    if (!flag(this.flags, LINK_FLAG.is_tiered_membership)) return this.availablePriceCents();
    const tierIds = (await this.tiersForNewBuyers()).map(idOf);
    if (tierIds.length === 0) return [];
    const variantIds = tierIds.length === 1 ? Prisma.sql`= ${tierIds[0]}` : Prisma.sql`IN (${Prisma.join(tierIds, ", ")})`;
    const prices = await cachedSelect<{ price_cents: number }>(
      Prisma.sql`SELECT \`prices\`.\`price_cents\` FROM \`prices\` WHERE \`prices\`.\`variant_id\` ${variantIds} AND \`prices\`.\`deleted_at\` IS NULL AND ((\`prices\`.\`flags\` & 1 = 0))`,
    );
    return [...new Set(prices.map((price) => price.price_cents))];
  }

  // Product::Prices#tiers_for_new_buyers: `tiers.alive`, less the tiers closed to new buyers.
  private async tiersForNewBuyers(): Promise<Row[]> {
    const tiers = (
      await cachedSelect<Row>(
        Prisma.sql`SELECT \`base_variants\`.* FROM \`base_variants\` INNER JOIN \`variant_categories\` ON \`base_variants\`.\`variant_category_id\` = \`variant_categories\`.\`id\` WHERE \`base_variants\`.\`type\` = 'Variant' AND \`variant_categories\`.\`link_id\` = ${this.id} AND \`variant_categories\`.\`deleted_at\` IS NULL AND \`variant_categories\`.\`title\` = 'Tier' AND \`base_variants\`.\`deleted_at\` IS NULL AND \`base_variants\`.\`deleted_at\` IS NULL`,
      )
    ).map((tier) => castRow("BaseVariant", tier));
    const open: Row[] = [];
    for (const tier of tiers) {
      if (tier.deleted_at != null) continue;
      if (!(await this.closedToNewBuyers(tier))) open.push(tier);
    }
    return open;
  }

  // BaseVariant#closed_to_new_buyers?. The tier's `link` (through its variant category) and that
  // link's `user` are fresh records in Ruby; the query cache answers them.
  private async closedToNewBuyers(tier: Row): Promise<boolean> {
    if (!flag(tier.flags, VARIANT_CLOSED_TO_NEW_PURCHASES)) return false;
    if (tier.type !== "Variant") return false;
    const category = tier.variant_category_id == null ? null : await findRow("VariantCategory", "variant_categories", tier.variant_category_id);
    const link = category?.link_id == null ? null : await findRow("Link", "links", category.link_id);
    if (!link) throw new NoMethodError("undefined method 'is_tiered_membership?' for nil");
    if (!flag(link.flags, LINK_FLAG.is_tiered_membership)) return false;
    const user = link.user_id == null ? null : await findRow("User", "users", link.user_id);
    return this.deps.featureActive(CLOSE_TO_NEW_BUYERS_FEATURE, user ? userActor(idOf(user)) : "");
  }

  // Link#product_and_universal_offer_codes, sorted by created_at.
  private async productAndUniversalOfferCodes(): Promise<Row[]> {
    const productCodes = await cachedSelect<Row>(
      Prisma.sql`SELECT \`offer_codes\`.* FROM \`offer_codes\` INNER JOIN \`offer_codes_products\` ON \`offer_codes\`.\`id\` = \`offer_codes_products\`.\`offer_code_id\` WHERE \`offer_codes_products\`.\`product_id\` = ${this.id} AND \`offer_codes\`.\`deleted_at\` IS NULL`,
    );
    const user = await this.requireUser("offer_codes");
    const universalCodes = await cachedSelect<Row>(
      Prisma.sql`SELECT \`offer_codes\`.* FROM \`offer_codes\` WHERE \`offer_codes\`.\`user_id\` = ${user.id} AND (universal = 1 and (currency_type = ${this.row.price_currency_type} or currency_type is null)) AND \`offer_codes\`.\`deleted_at\` IS NULL AND (NOT EXISTS (SELECT 1 FROM offer_codes_excluded_products WHERE offer_codes_excluded_products.offer_code_id = offer_codes.id AND offer_codes_excluded_products.product_id = ${String(this.id)}))`,
    );
    const createdAt = (code: Row) => new Date(code.created_at as Date | string).getTime();
    return [...productCodes, ...universalCodes].sort((a, b) => createdAt(a) - createdAt(b));
  }

  // Link#taxonomy_attribute_filter_tokens
  private async taxonomyAttributeFilterTokens(): Promise<string[]> {
    const data = linkJsonData(this.row.json_data);
    const section = (key: string): Record<string, JsonValue> => {
      const value = data?.[key];
      return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && !(value instanceof RubyFloat) && Object.keys(value).length > 0
        ? (value as Record<string, JsonValue>)
        : {};
    };
    const values = { ...section("inferred_taxonomy_attribute_values"), ...section("taxonomy_attribute_values") };
    const tokens: string[] = [];
    for (const attribute of await this.taxonomyAttributes()) {
      const token = filterTokenFor(attribute, values[String(attribute.name)]);
      if (token !== null) tokens.push(token);
    }
    return tokens;
  }

  // `taxonomy&.taxonomy_attributes`, an association of the (memoized) taxonomy.
  private async taxonomyAttributes(): Promise<Row[]> {
    const taxonomy = await this.taxonomy();
    if (!taxonomy) return [];
    this.taxonomyAttributesMemo ??= cachedSelect<Row>(
      Prisma.sql`SELECT \`taxonomy_attributes\`.* FROM \`taxonomy_attributes\` WHERE \`taxonomy_attributes\`.\`taxonomy_id\` = ${taxonomy.id} AND \`taxonomy_attributes\`.\`active\` = TRUE ORDER BY \`taxonomy_attributes\`.\`position\` ASC, \`taxonomy_attributes\`.\`id\` ASC`,
    ).then((rows) => rows.map((attribute) => castRow("TaxonomyAttribute", attribute)));
    return this.taxonomyAttributesMemo;
  }

  // Link#rated_as_adult?
  private async ratedAsAdult(): Promise<boolean> {
    if (flag(this.flags, LINK_FLAG.is_adult)) return true;
    const user = await this.requireUser("all_adult_products?");
    if (flag(user.flags, USER_ALL_ADULT_PRODUCTS)) return true;
    return [this.row.name, this.row.description, user.name, username(user), user.bio].some((text) => isAdult(text as string | null));
  }

  // Product::Recommendations#recommendable_reasons: every reason is evaluated, in this order.
  private async isRecommendable(): Promise<boolean> {
    const reasons: boolean[] = [this.alive, !flag(this.flags, LINK_FLAG.archived), flag(this.flags, LINK_FLAG.display_product_reviews)];
    const max = this.row.max_purchase_count;
    if (max != null) {
      const [row] = await cachedSelect<{ sales_count_for_inventory_cache: unknown }>(
        Prisma.sql`SELECT \`links\`.\`sales_count_for_inventory_cache\` FROM \`links\` WHERE \`links\`.\`id\` = ${this.id} LIMIT 1`,
      );
      reasons.push(Number(row?.sales_count_for_inventory_cache ?? 0) < Number(max));
    } else {
      reasons.push(true);
    }
    reasons.push((await this.taxonomy()) !== null);
    const sale = await cachedSelect(
      Prisma.sql`SELECT 1 AS one FROM \`purchases\` WHERE \`purchases\`.\`link_id\` = ${this.id} AND \`purchases\`.\`purchase_state\` = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) LIMIT 1`,
    );
    reasons.push(sale.length > 0);
    const user = await this.requireUser("recommendable_reasons");
    reasons.push(!isBlank(user.name) || !isBlank(username(user)), user.deleted_at == null, await payoutFilled(user), user.user_risk_state === "compliant");
    return reasons.every(Boolean);
  }
}

// User#username
function username(user: Row): unknown {
  return isBlank(user.username) ? user.external_id : user.username;
}

const merchantAccounts = (userId: unknown, processor: string) =>
  cachedSelect<MerchantAccountRow>(
    Prisma.sql`SELECT \`merchant_accounts\`.* FROM \`merchant_accounts\` WHERE \`merchant_accounts\`.\`user_id\` = ${userId} AND \`merchant_accounts\`.\`deleted_at\` IS NULL AND \`merchant_accounts\`.\`charge_processor_alive_at\` IS NOT NULL AND \`merchant_accounts\`.\`charge_processor_deleted_at\` IS NULL AND \`merchant_accounts\`.\`charge_processor_id\` = ${processor}`,
  );

// User::Recommendations' payout_filled: a payment address, a live bank account, a Stripe Connect
// account, or a PayPal account that can take charges, checked in that order.
async function payoutFilled(user: Row): Promise<boolean> {
  if (!isBlank(user.payment_address)) return true;
  const bankAccounts = await cachedSelect(
    Prisma.sql`SELECT \`bank_accounts\`.* FROM \`bank_accounts\` WHERE \`bank_accounts\`.\`user_id\` = ${user.id} AND \`bank_accounts\`.\`deleted_at\` IS NULL ORDER BY \`bank_accounts\`.\`id\` ASC LIMIT 1`,
  );
  if (bankAccounts.length > 0) return true;
  if ((await merchantAccounts(user.id, "stripe")).some(isStripeConnectAccount)) return true;
  // MerchantAccount#can_accept_charges? is true for any account not on Stripe.
  return (await merchantAccounts(user.id, "paypal")).length > 0;
}
