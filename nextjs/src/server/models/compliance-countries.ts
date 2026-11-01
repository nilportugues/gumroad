// Port of lib/utilities/compliance/countries.rb: the parts that are lookups over the `countries` gem's
// data (config/initializers/countries.rb applied). The data is generated from the gem by
// scripts/golden/countries.rb into countries.generated.json; countries.test.ts replays the answers
// that script recorded from Ruby and fails when the files it was generated from change.
import COUNTRY_DATA from "./countries.generated.json" with { type: "json" };

export type Country = {
  alpha2: string;
  alpha3: string;
  common_name: string;
  currency_code: string | null;
  historical_names: string[] | null;
  names: string[];
};

export const COUNTRIES: readonly Country[] = COUNTRY_DATA.countries as Country[];
const BY_ALPHA2 = new Map(COUNTRIES.map((country) => [country.alpha2, country]));
const BY_ALPHA3 = new Map(COUNTRIES.map((country) => [country.alpha3, country]));
const ACCENT_MAP = new Map(Object.entries(COUNTRY_DATA.accent_map));

// Compliance::Countries.mapping
export const mapping = (): Array<[string, string]> => COUNTRIES.map((country) => [country.alpha2, country.common_name]);

// ISO3166::Country[alpha2] and ISO3166::Country.find_country_by_alpha3
export const countryByAlpha2 = (alpha2: string): Country | null => BY_ALPHA2.get(alpha2.toUpperCase()) ?? null;
export const countryByAlpha3 = (alpha3: string): Country | null => BY_ALPHA3.get(alpha3.toUpperCase()) ?? null;

// ActiveSupport's `String#blank?`: `/\A[[:space:]]*\z/`, Unicode White_Space.
const WHITE_SPACE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
const isWhiteSpace = (codePoint: number) => WHITE_SPACE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
export const isBlank = (value: string | null | undefined): boolean => value == null || [...value].every((char) => isWhiteSpace(char.codePointAt(0)!));

// Unaccent.unaccent: each non-ASCII character through ACCENTMAP.
const unaccent = (value: string): string => value.replace(/[^\x00-\x7f]/gu, (char) => ACCENT_MAP.get(char) ?? char);

// ISO3166::Country.parse_value (CountryFinderMethods): drop "(", ")", "[]" and ",", unaccent, downcase.
// Ruby lowercases each character on its own; JavaScript turns a word-final capital sigma into the final form.
const rubyDowncase = (value: string): string => Array.from(value, (char) => char.toLowerCase()).join("");
export const parseCountryName = (value: string): string => rubyDowncase(unaccent(value.replace(/\(|\)|\[\]|,/gu, "")));

// Every searched name, parsed. `find_country_by_any_name` returns `countries.last` of the matches, so the
// country that comes last in the gem's order wins a name two countries share.
let nameIndex: Map<string, Country> | undefined;
function countriesByParsedName(): Map<string, Country> {
  if (nameIndex === undefined) {
    nameIndex = new Map();
    for (const country of COUNTRIES) for (const name of country.names) nameIndex.set(parseCountryName(name), country);
  }
  return nameIndex;
}
export const parsedNameIndex = (): ReadonlyMap<string, string> => new Map([...countriesByParsedName()].map(([name, country]) => [name, country.alpha2]));

// Compliance::Countries.find_by_name
export function findByName(countryName: string | null | undefined): Country | null {
  if (countryName == null || isBlank(countryName)) return null;
  return countriesByParsedName().get(parseCountryName(countryName)) ?? null;
}

// Compliance::Countries.find_by_name(name)&.alpha2
export const alpha2ByName = (countryName: string | null | undefined): string | null => findByName(countryName)?.alpha2 ?? null;

// Compliance::Countries.historical_names
export function historicalNames(countryName: string | null | undefined): string[] {
  const country = findByName(countryName);
  if (country === null) return [];
  return [...new Set([country.common_name, ...(country.historical_names ?? [])])];
}

const BLOCKED_COUNTRY_CODES: ReadonlySet<string> = new Set(COUNTRY_DATA.blocked_country_codes);
const RISK_PHYSICAL_BLOCKED_COUNTRY_CODES: ReadonlySet<string> = new Set(COUNTRY_DATA.risk_physical_blocked_country_codes);
export const isBlockedCountry = (alpha2: string): boolean => BLOCKED_COUNTRY_CODES.has(alpha2);
export const isRiskPhysicalBlocked = (alpha2: string): boolean => RISK_PHYSICAL_BLOCKED_COUNTRY_CODES.has(alpha2);

// StripeMerchantAccountManager::COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT, as alpha2 codes
export const COUNTRIES_SUPPORTED_BY_STRIPE_CONNECT: readonly string[] = COUNTRY_DATA.stripe_connect_countries;
