// Country#default_currency (app/models/country.rb): the currency a seller's account moves to when its compliance country is set.
const EUR_COUNTRIES = [
  "AT",
  "BE",
  "HR",
  "CY",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PT",
  "SK",
  "SI",
  "ES",
];

const DEFAULT_CURRENCIES: ReadonlyMap<string, string> = new Map([
  ["US", "usd"],
  ["CA", "cad"],
  ["SG", "sgd"],
  ["AU", "aud"],
  ["GB", "gbp"],
  ...EUR_COUNTRIES.map((code): [string, string] => [code, "eur"]),
  ["HK", "hkd"],
  ["NZ", "nzd"],
  ["CH", "chf"],
  ["PL", "pln"],
  ["CZ", "czk"],
  ["JP", "jpy"],
  ["LI", "chf"],
]);

export const defaultCurrency = (alpha2: string | null | undefined): string | null =>
  alpha2 == null ? null : (DEFAULT_CURRENCIES.get(alpha2) ?? null);
