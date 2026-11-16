// Port of app/models/concerns/with_filtering.rb, the read side: the recipient-type predicates and
// `purchase_passes_filters` / `seller_post_passes_filters` that Workflow and Installment share. The
// filters live in `json_data`; `FilterData` is that hash as the `attr_json_data_accessor`s read it.
//
// Filters whose Ruby meaning depends on a value Node would have to guess (a string where a number is
// compared, a date that is not ISO 8601, ...) throw NotPortedError. `assertFiltersSupported` runs the
// same checks without reading anything, so a job can hand itself back before its first write.
// Golden: worker/jobs/__fixtures__/workflow-jobs.golden.json (scripts/golden/workflow-jobs.rb).
import { Prisma, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import type { YamlValue } from "./concerns/psych.ts";
import { rubyToI } from "./concerns/ruby-numeric.ts";
import { floatValue, isRubyFloat } from "./concerns/ruby-values.ts";
import { rubyJsonParse } from "./concerns/serialized-columns.ts";
import { nilReceiver } from "./offer-code.ts";
import { PURCHASES } from "./purchase.ts";
import type { PurchaseRecord } from "./purchase-pricing.ts";
import { isBlank } from "./runtime/validators.ts";
import { column, columnIn, quoteName, selectRows, table } from "./sql.ts";
import { purchaseFlagScope } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

export const AUDIENCE_TYPE = "audience";
export const SELLER_TYPE = "seller";
export const PRODUCT_TYPE = "product";
export const VARIANT_TYPE = "variant";
export const FOLLOWER_TYPE = "follower";
export const AFFILIATE_TYPE = "affiliate";
export const ABANDONED_CART_TYPE = "abandoned_cart";

// `scope :seller_or_audience_type` and the others: the recipient types a scope lists.
export const RECIPIENT_TYPES = {
  sellerOrAudience: [SELLER_TYPE, AUDIENCE_TYPE],
  sellerOrProductOrVariant: [SELLER_TYPE, PRODUCT_TYPE, VARIANT_TYPE],
} as const;

type Hash = { [key: string]: YamlValue };

// ArgumentError, as `json_data` raises it for a column that holds something other than a Hash.
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

// `json_data` (JsonData): NULL and an empty column are `{}`. The column is not valid JSON, or is JSON
// that is not an object: Ruby raises; Node does not reproduce the parser's message.
export function parseJsonData(text: string | null): Hash {
  if (text === null || text.trim() === "") return {};
  let parsed: YamlValue;
  try {
    parsed = rubyJsonParse(text);
  } catch {
    throw new NotPortedError("json_data that is not valid JSON", "json_data.rb");
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed) || isRubyFloat(parsed) || !isPlainObject(parsed)) throw new ArgumentError("json_data must be a hash");
  return parsed as Hash;
}

const isPlainObject = (value: unknown): value is Hash => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

// Anything with a `json_data` hash and a recipient type column.
export type Filterable = {
  jsonData(): Hash;
  // `seller`, for the existence probe of `not_bought_*`
  seller(): Promise<User | null>;
  recipientType(): string | null;
};

// `json_data_for_attr(attribute)`: the stored value when `present?`, else nil.
export function filterValue(subject: Pick<Filterable, "jsonData">, key: string): YamlValue {
  const value = subject.jsonData()[key];
  return value === undefined || isBlank(value) ? null : value;
}

// ActiveModel::Type::Boolean#cast
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);
export function castBoolean(value: YamlValue): boolean | null {
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return value !== 0 && value !== 0n ? true : false;
  return !(typeof value === "string" && FALSE_VALUES.has(value));
}

const refuse = (what: string): never => {
  throw new NotPortedError(what, "with_filtering.rb");
};

function numeric(value: YamlValue, key: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (isRubyFloat(value)) return floatValue(value);
  return refuse(`${key} that is not a number`);
}

function stringList(value: YamlValue, key: string): string[] {
  if (!Array.isArray(value)) return refuse(`${key} that is not a list`);
  return value.map((item) => (typeof item === "string" ? item : refuse(`${key} with a value that is not a string`)));
}

// `Time < "2025-01-01T00:00:00.000-08:00"`: ActiveSupport coerces the String with `to_datetime`. Only
// the ISO 8601 form the filters are stored in is ported.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
function timeFilter(value: YamlValue, key: string): Date {
  if (typeof value !== "string" || !ISO_TIME.test(value)) return refuse(`${key} that is not an ISO 8601 time`);
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return refuse(`${key} that is not a valid time`);
  return time;
}

// External variant ids as `BaseVariant.by_external_ids` decodes them; one that does not decode is
// `nil` in the `IN` list, which Node leaves to Ruby.
function variantIds(externalIds: string[]): number[] {
  return externalIds.map((id) => decrypt(id) ?? refuse("a variant external id that does not decode"));
}

// `minimum_license_uses.to_i`
const minimumLicenseUses = (value: YamlValue): number => (typeof value === "string" ? rubyToI(value) : Math.trunc(numeric(value, "minimum_license_uses")));

export type Filters = {
  createdAfter: Date | null;
  createdBefore: Date | null;
  boughtProducts: string[];
  boughtVariants: string[];
  paidMoreThanCents: number | null;
  paidLessThanCents: number | null;
  boughtFrom: string | null;
  activeCustomersOnly: YamlValue;
  minimumLicenseUses: YamlValue;
  notBoughtProducts: string[];
  notBoughtVariants: string[];
};

// The filters of `subject`, with the checks of the types Node compares. Throws NotPortedError for a
// value it cannot judge. Reads nothing from the database.
export function readFilters(subject: Pick<Filterable, "jsonData">): Filters {
  const value = (key: string) => filterValue(subject, key);
  const list = (key: string) => (value(key) === null ? [] : stringList(value(key), key));
  const filters: Filters = {
    createdAfter: value("created_after") === null ? null : timeFilter(value("created_after"), "created_after"),
    createdBefore: value("created_before") === null ? null : timeFilter(value("created_before"), "created_before"),
    boughtProducts: list("bought_products"),
    boughtVariants: list("bought_variants"),
    paidMoreThanCents: value("paid_more_than_cents") === null ? null : numeric(value("paid_more_than_cents"), "paid_more_than_cents"),
    paidLessThanCents: value("paid_less_than_cents") === null ? null : numeric(value("paid_less_than_cents"), "paid_less_than_cents"),
    boughtFrom: value("bought_from") === null ? null : (typeof value("bought_from") === "string" ? (value("bought_from") as string) : refuse("bought_from that is not a string")),
    activeCustomersOnly: value("active_customers_only"),
    minimumLicenseUses: value("minimum_license_uses"),
    notBoughtProducts: list("not_bought_products"),
    notBoughtVariants: list("not_bought_variants"),
  };
  if (filters.minimumLicenseUses !== null && !(typeof filters.minimumLicenseUses === "string" || typeof filters.minimumLicenseUses === "number" || isRubyFloat(filters.minimumLicenseUses))) {
    refuse("minimum_license_uses that is not a number");
  }
  variantIds(filters.notBoughtVariants);
  return filters;
}

// What `purchase_passes_filters` hands `seller_post_passes_filters`.
export type PurchaseFacts = {
  email: string | null;
  minCreatedAt: Date | null;
  maxCreatedAt: Date | null;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  country: string | null;
  ipCountry: string | null;
  productPermalinks: string[];
  variantExternalIds: string[];
  subscriptionCancelled: boolean;
  licenseUses: number | null;
};

// `seller.sales.where(email:).<scopes>.by_external_variant_ids_or_products(variants, product_ids).exists?`
async function boughtBySellerBefore(seller: User, email: string | null, notBoughtVariants: string[], productIds: number[]): Promise<boolean> {
  const emailCondition = email === null ? Prisma.sql`${column(PURCHASES, "email")} IS NULL` : Prisma.sql`${column(PURCHASES, "email")} = ${email}`;
  const base = Prisma.sql`${column(PURCHASES, "seller_id")} = ${seller.id} AND ${emailCondition} AND ${purchaseFlagScope("is_archived_original_subscription_purchase", false)} AND (purchases.subscription_id IS NULL OR purchases.flags & '4' = '4' OR purchases.flags & '32' = '32')`;
  let condition = Prisma.empty;
  if (notBoughtVariants.length > 0) {
    const ids = await selectRows<{ id: bigint | number }>(Prisma.sql`SELECT ${column("base_variants", "id")} FROM ${table("base_variants")} WHERE ${columnIn("base_variants", "id", variantIds(notBoughtVariants))}`);
    const quoted = Prisma.raw(ids.map((row) => `'${String(row.id)}'`).join(", "));
    const byVariants =
      ids.length === 0
        ? Prisma.sql`SELECT ${star(PURCHASES)} FROM ${table(PURCHASES)} WHERE ${base}`
        : Prisma.sql`SELECT ${star(PURCHASES)} FROM ${table(PURCHASES)} INNER JOIN base_variants_purchases ON base_variants_purchases.purchase_id = purchases.id WHERE ${base} AND (base_variants_purchases.base_variant_id IN (${quoted}))`;
    const byProducts = Prisma.sql`SELECT ${star(PURCHASES)} FROM ${table(PURCHASES)} WHERE ${base} AND ${columnIn(PURCHASES, "link_id", productIds)}`;
    condition = Prisma.sql` AND (purchases.id IN (SELECT id FROM ((${byVariants}) UNION (${byProducts})) AS t_purchases))`;
  } else {
    condition = Prisma.sql` AND ${columnIn(PURCHASES, "link_id", productIds)}`;
  }
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(PURCHASES)} WHERE ${base}${condition} LIMIT 1`);
  return rows.length > 0;
}

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);

// `seller_post_passes_filters` (the cache and probe batch of its callers are not ported: callers that
// pass them stay in Ruby).
export async function sellerPostPassesFilters(subject: Filterable, facts: PurchaseFacts): Promise<boolean> {
  const f = readFilters(subject);
  if (f.createdAfter !== null && (facts.minCreatedAt === null || facts.minCreatedAt < f.createdAfter)) return false;
  if (f.createdBefore !== null && (facts.maxCreatedAt === null || facts.maxCreatedAt > f.createdBefore)) return false;
  const excludesProduct = f.boughtProducts.length > 0 && (facts.productPermalinks.length === 0 || !f.boughtProducts.some((p) => facts.productPermalinks.includes(p)));
  const excludesVariants = f.boughtVariants.length > 0 && (facts.variantExternalIds.length === 0 || !f.boughtVariants.some((v) => facts.variantExternalIds.includes(v)));
  if (f.boughtProducts.length > 0 && f.boughtVariants.length > 0) {
    if (excludesProduct && excludesVariants) return false;
  } else if (f.boughtProducts.length > 0) {
    if (excludesProduct) return false;
  } else if (f.boughtVariants.length > 0) {
    if (excludesVariants) return false;
  }

  if (f.paidMoreThanCents !== null && (facts.minPriceCents === null || facts.minPriceCents < f.paidMoreThanCents)) return false;
  if (f.paidLessThanCents !== null && (facts.maxPriceCents === null || facts.maxPriceCents > f.paidLessThanCents)) return false;
  if (f.boughtFrom !== null && !(facts.country === f.boughtFrom || (facts.country === null && facts.ipCountry === f.boughtFrom))) return false;
  if (castBoolean(f.activeCustomersOnly) === true && facts.subscriptionCancelled) return false;
  if (f.minimumLicenseUses !== null && (facts.licenseUses === null || facts.licenseUses < minimumLicenseUses(f.minimumLicenseUses))) return false;

  let excludeProductIds: number[] = [];
  if (f.notBoughtProducts.length > 0) {
    const rows = await selectRows<{ id: bigint | number }>(Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${columnIn("links", "unique_permalink", f.notBoughtProducts)}`);
    excludeProductIds = rows.map((row) => Number(row.id));
  }
  if (excludeProductIds.length > 0 || f.notBoughtVariants.length > 0) {
    const seller = await subject.seller();
    if (seller === null) throw nilReceiver("sales");
    if (await boughtBySellerBefore(seller, facts.email, f.notBoughtVariants, excludeProductIds)) return false;
  }
  return true;
}

// `purchase_passes_filters(purchase)`: the facts come from the purchase's own row and the associations
// Ruby reads for them, in the order it reads them.
export async function purchasePassesFilters(subject: Filterable, purchase: PurchaseRecord): Promise<boolean> {
  const row = purchase.row;
  const link = await purchase.link();
  if (link === null) throw nilReceiver("unique_permalink");
  const variants = await purchase.variantAttributes();
  const subscription = await purchase.subscriptionRow();
  const license = await purchase.license();
  return sellerPostPassesFilters(subject, {
    email: row.email,
    minCreatedAt: row.created_at,
    maxCreatedAt: row.created_at,
    minPriceCents: row.price_cents,
    maxPriceCents: row.price_cents,
    country: row.country,
    ipCountry: row.ip_country,
    productPermalinks: [link.unique_permalink ?? refuse("a product without a permalink")],
    variantExternalIds: variants.map((variant) => encrypt(variant.row.id)),
    subscriptionCancelled: subscription !== null && subscription.cancelled_at != null,
    licenseUses: license === null ? null : license.uses,
  });
}
