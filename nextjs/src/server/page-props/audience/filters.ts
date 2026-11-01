// WithFiltering#json_filters: the audience filters of a workflow or an email, as the pages show them.
import type { User } from "@prisma/client";

import type { YamlValue } from "../../models/concerns/psych.ts";
import { rubyToI } from "../../models/concerns/ruby-numeric.ts";
import { castBoolean, filterValue, type Filterable } from "../../models/with-filtering.ts";
import { NotPortedError } from "../not-ported.ts";
import DATA from "./audience-data.generated.json" with { type: "json" };

type Currency = { symbol: string; decimal_mark: string; thousands_separator: string; exponent: number; subunit_to_unit: number };
const CURRENCIES = DATA.currencies as Record<string, Currency>;

export const currencyFor = (currencyType: string | null): Currency => {
  const currency = CURRENCIES[(currencyType ?? "usd").toLowerCase()];
  if (!currency) throw new NotPortedError(`Money formatting for the ${JSON.stringify(currencyType)} currency`);
  return currency;
};

// User#currency_symbol
export const currencySymbol = (seller: User): string => currencyFor(seller.currency_type).symbol;

// Money.new(cents, currency).format(no_cents_if_whole: true, symbol: false)
export function formatMoney(cents: number, currencyType: string | null): string {
  const currency = currencyFor(currencyType);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / currency.subunit_to_unit);
  const fraction = absolute % currency.subunit_to_unit;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, currency.thousands_separator);
  const decimals = fraction === 0 || currency.exponent === 0 ? "" : `${currency.decimal_mark}${String(fraction).padStart(currency.exponent, "0")}`;
  return `${negative ? "-" : ""}${grouped}${decimals}`;
}

// `convert_to_date(date)`: Date.parse of a stored string. Only the leading ISO date is ported.
function convertToDate(value: YamlValue, key: string): string {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  if (!match) throw new NotPortedError(`${key} that is not an ISO 8601 date`);
  return match[1]!;
}

const cents = (value: YamlValue, key: string): number => {
  if (typeof value !== "number") throw new NotPortedError(`${key} that is not a number`);
  return value;
};

export function jsonFilters(subject: Pick<Filterable, "jsonData">, seller: User): Record<string, unknown> {
  const value = (key: string) => filterValue(subject, key);
  const json: Record<string, unknown> = {};
  for (const key of ["bought_products", "not_bought_products", "not_bought_variants", "bought_variants"]) {
    if (value(key) !== null) json[key] = value(key);
  }
  if (value("paid_more_than_cents") !== null) json.paid_more_than = formatMoney(cents(value("paid_more_than_cents"), "paid_more_than_cents"), seller.currency_type);
  if (value("paid_less_than_cents") !== null) json.paid_less_than = formatMoney(cents(value("paid_less_than_cents"), "paid_less_than_cents"), seller.currency_type);
  if (value("created_after") !== null) json.created_after = convertToDate(value("created_after"), "created_after");
  if (value("created_before") !== null) json.created_before = convertToDate(value("created_before"), "created_before");
  if (value("bought_from") !== null) json.bought_from = value("bought_from");
  if (castBoolean(value("active_customers_only"))) json.active_customers_only = true;
  if (value("minimum_license_uses") !== null) {
    const uses = typeof value("minimum_license_uses") === "string" ? rubyToI(value("minimum_license_uses") as string) : Math.trunc(Number(value("minimum_license_uses")));
    if (uses > 0) json.minimum_license_uses = uses;
  }
  for (const key of ["affiliate_products", "waitlisted_products", "not_clicked_post_id", "workflow_trigger"]) {
    if (value(key) !== null) json[key] = value(key);
  }
  return json;
}
