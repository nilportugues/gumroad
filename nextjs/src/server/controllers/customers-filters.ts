// Port of the filter half of CustomersController#paged and #fetch_sales (app/controllers/customers_controller.rb): the
// products, variants, amounts, dates, country, license uses and active-customers parameters, as PurchaseSearchService options.
//
// Handed back to Rails (HandBackToRails): a parameter that is not a string (or a list of strings), an amount that is not
// a plain integer, and a date that is not ISO 8601, where `TimeZone#parse` would read it by Date._parse's own rules.
import { Prisma, type User } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { getUsdCents } from "../models/concerns/currency-helper.ts";
import { column, columnIn, selectRows, table } from "../models/sql.ts";
import { addDays, dayStartIso, offsetMinutesAt, timezoneId, TimeZoneNotPortedError } from "../search/civil-time.ts";
import { rubyToI } from "../models/concerns/ruby-numeric.ts";
import { castBoolean, type Params } from "../search/ruby-params.ts";
import { HandBackToRails } from "./application-controller.ts";

const MAX_AMOUNT_DIGITS = 15;
const DAY_MS = 86_400_000;
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

export type CustomersFilterParams = {
  products: string[];
  variants: string[];
  excludedProducts: string[];
  excludedVariants: string[];
  minimumAmountCents?: string;
  maximumAmountCents?: string;
  createdAfter?: string;
  createdBefore?: string;
  country?: string;
  activeCustomersOnly: boolean;
  minimumLicenseUses?: string;
};

export const FILTER_PARAMS = [
  "products", "variants", "excluded_products", "excluded_variants", "minimum_amount_cents", "maximum_amount_cents",
  "created_after", "created_before", "country", "active_customers_only", "minimum_license_uses",
] as const;

function scalar(params: Params, key: string): string | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (typeof value !== "string") throw new HandBackToRails(`a non-scalar ${key}`);
  return value;
}

// `Array.wrap(params[key])`
function list(params: Params, key: string): string[] {
  if (!(key in params)) return [];
  const value = params[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  throw new HandBackToRails(`a ${key} that is not a list of strings`);
}

export function readFilterParams(params: Params): CustomersFilterParams {
  const active = scalar(params, "active_customers_only");
  return {
    products: list(params, "products"),
    variants: list(params, "variants"),
    excludedProducts: list(params, "excluded_products"),
    excludedVariants: list(params, "excluded_variants"),
    minimumAmountCents: scalar(params, "minimum_amount_cents"),
    maximumAmountCents: scalar(params, "maximum_amount_cents"),
    createdAfter: scalar(params, "created_after"),
    createdBefore: scalar(params, "created_before"),
    country: scalar(params, "country"),
    // ActiveModel::Type::Boolean.new.cast(params[:active_customers_only])
    activeCustomersOnly: castBoolean(active) === true,
    minimumLicenseUses: scalar(params, "minimum_license_uses"),
  };
}

// `Model.by_external_ids(ids)` as the search reads it: the rows that exist. An id that does not decode is `IN (NULL)`.
async function existingIds(tableName: "links" | "base_variants", externalIds: string[]): Promise<{ id: number }[]> {
  const decoded = externalIds.map((externalId) => decrypt(externalId)).filter((id): id is number => id !== null);
  if (decoded.length === 0) return [];
  const rows = await selectRows<{ id: bigint | number }>(Prisma.sql`SELECT ${column(tableName, "id")} FROM ${table(tableName)} WHERE ${columnIn(tableName, "id", decoded)} ORDER BY ${column(tableName, "id")} ASC`);
  return rows.map((row) => ({ id: Number(row.id) }));
}

// `get_usd_cents(current_seller.currency_type, amount)` for an amount string. `BigDecimal(amount)` accepts more
// shapes (decimals, exponents, blanks around it); only digits are read here.
async function usdCents(seller: User, amount: string): Promise<number> {
  if (!/^\d+$/u.test(amount) || amount.length > MAX_AMOUNT_DIGITS) throw new HandBackToRails("an amount that is not a plain integer");
  if (seller.currency_type === null) throw new HandBackToRails("a seller without a currency type");
  return getUsdCents(seller.currency_type, Number(amount));
}

// `timezone.parse(value)` for the two shapes the table sends: a calendar date (midnight in the zone) and an ISO 8601 instant.
function parseInZone(value: string, iana: string): { time: Date; date: string | null } {
  const plain = PLAIN_DATE.exec(value);
  if (plain) {
    const probe = new Date(Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])));
    if (probe.getUTCMonth() !== Number(plain[2]) - 1 || probe.getUTCDate() !== Number(plain[3])) throw new HandBackToRails("an impossible date");
    return { time: new Date(dayStartIso(value, iana)), date: value };
  }
  if (!ISO_INSTANT.test(value)) throw new HandBackToRails("a date that is not ISO 8601");
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new HandBackToRails("an impossible date");
  return { time, date: null };
}

// `.tomorrow` on a TimeWithZone: the same wall clock on the next day. Across a DST change that is not 24 hours later.
function tomorrow(parsed: { time: Date; date: string | null }, iana: string): Date {
  if (parsed.date !== null) return new Date(dayStartIso(addDays(parsed.date, 1), iana));
  const next = new Date(parsed.time.getTime() + DAY_MS);
  if (offsetMinutesAt(next.getTime(), iana) !== offsetMinutesAt(parsed.time.getTime(), iana)) throw new HandBackToRails("a day across a DST change");
  return next;
}

// The `created_after || created_before` block of #fetch_sales. A window that ends before it starts is dropped.
export function createdWindow(seller: Pick<User, "timezone">, createdAfter: string | undefined, createdBefore: string | undefined): { created_on_or_after?: Date; created_before?: Date } {
  if (createdAfter === undefined && createdBefore === undefined) return {};
  try {
    const iana = timezoneId(seller.timezone);
    const after = createdAfter === undefined ? undefined : parseInZone(createdAfter, iana).time;
    const before = createdBefore === undefined ? undefined : tomorrow(parseInZone(createdBefore, iana), iana);
    if (after !== undefined && before !== undefined && after > before) return {};
    return { ...(after === undefined ? {} : { created_on_or_after: after }), ...(before === undefined ? {} : { created_before: before }) };
  } catch (error) {
    if (error instanceof TimeZoneNotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

const filled = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

// The PurchaseSearchService options #fetch_sales adds for the filters. `country` (even blank) wins over `bought_from`, so the
// caller reads that from `country` here.
export async function customersSalesFilters(seller: User, filters: CustomersFilterParams): Promise<Params> {
  const options: Params = {};
  const products = await existingIds("links", filters.products);
  const variants = await existingIds("base_variants", filters.variants);
  options.exclude_purchasers_of_product = await existingIds("links", filters.excludedProducts);
  options.exclude_purchasers_of_variant = await existingIds("base_variants", filters.excludedVariants);
  const anyProductsOrVariants: Params = {};
  if (products.length > 0) anyProductsOrVariants.products = products;
  if (variants.length > 0) anyProductsOrVariants.variants = variants;
  options.any_products_or_variants = anyProductsOrVariants;

  if (filters.activeCustomersOnly) {
    options.exclude_deactivated_subscriptions = true;
    options.exclude_cancelled_or_pending_cancellation_subscriptions = true;
    options.exclude_refunded_except_subscriptions = true;
    options.exclude_unreversed_chargedback = true;
  }
  if (filled(filters.minimumAmountCents)) options.price_greater_than = await usdCents(seller, filters.minimumAmountCents);
  if (filled(filters.maximumAmountCents)) options.price_less_than = await usdCents(seller, filters.maximumAmountCents);
  if (filled(filters.minimumLicenseUses) && (await isFeatureEnabled("license_uses_sales_filter", userActor(seller.id)))) {
    options.license_uses_greater_than_or_equal_to = rubyToI(filters.minimumLicenseUses);
  }
  Object.assign(options, createdWindow(seller, filters.createdAfter, filters.createdBefore));
  return options;
}
