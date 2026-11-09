// Port of lib/utilities/compliance/countries.rb (tax country lists, TAXABLE_US_STATE_CODES, tax_name_for) and
// lib/utilities/compliance.rb (Canary Islands / Ceuta / Melilla postal-code exemption). Keep in sync with those files.

export const QUEBEC = "QC"; // config/initializers/004_constants.rb

export const EU_VAT_APPLICABLE_COUNTRY_CODES: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB",
];
// SalesTaxCalculator::EU_VAT_DESTINATION_COUNTRY_CODES: the EU-27, the UK having left the customs union.
export const EU_VAT_DESTINATION_COUNTRY_CODES: readonly string[] = EU_VAT_APPLICABLE_COUNTRY_CODES.filter((code) => code !== "GB");
export const NORWAY_VAT_APPLICABLE_COUNTRY_CODES: readonly string[] = ["NO"];
export const GST_APPLICABLE_COUNTRY_CODES: readonly string[] = ["AU", "SG"];
export const COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS: readonly string[] = ["IS", "JP", "NZ", "ZA", "CH", "AE", "IN"];
export const COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITH_TAX_ID_PRO_VALIDATION: readonly string[] = [
  "BY", "CL", "CO", "CR", "EC", "EG", "GE", "KZ", "MY", "MD", "MA", "RU", "SA", "RS", "KR", "TH", "TR", "UA", "UZ", "VN",
];
export const COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITHOUT_TAX_ID_PRO_VALIDATION: readonly string[] = ["BH", "KE", "NG", "OM", "TZ"];
export const COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS: readonly string[] = [
  ...COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITH_TAX_ID_PRO_VALIDATION,
  ...COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS_WITHOUT_TAX_ID_PRO_VALIDATION,
];

export const TAXABLE_US_STATE_CODES: readonly string[] = [
  "AR", "AZ", "CO", "CT", "DC", "GA", "HI", "IA", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "MI", "MN", "NC", "ND", "NE", "NJ",
  "NV", "NY", "OH", "OK", "PA", "RI", "SD", "TN", "TX", "UT", "VT", "WA", "WI", "WV", "WY",
];
export const isTaxableState = (stateCode: string | null | undefined): boolean => stateCode != null && TAXABLE_US_STATE_CODES.includes(stateCode);

const TAX_NAME_BY_COUNTRY_CODE: Readonly<Record<string, string>> = { IN: "GST", NZ: "GST", AU: "GST", SG: "GST", MY: "Service tax", JP: "CT" };
export const taxNameFor = (countryCode: string): string => (Object.hasOwn(TAX_NAME_BY_COUNTRY_CODE, countryCode) ? TAX_NAME_BY_COUNTRY_CODE[countryCode]! : "VAT");

// Compliance.es_postal_code_vat_exempt?: Las Palmas, Santa Cruz de Tenerife, Ceuta, Melilla.
const ES_VAT_EXEMPT_POSTAL_PREFIXES = ["35", "38", "51", "52"];
export const VAT_EXEMPT_REGIONS: readonly string[] = ["Canarias", "Canary Islands"];

// Ruby's String#strip drops ASCII whitespace and NUL; `\d` in Ruby regexes is ASCII-only, as here.
export function esPostalCodeVatExempt(postalCode: string | null | undefined): boolean {
  const digits = (postalCode ?? "").replace(/^[\t\n\v\f\r \0]+|[\t\n\v\f\r \0]+$/gu, "");
  return /^\d{5}$/u.test(digits) && ES_VAT_EXEMPT_POSTAL_PREFIXES.includes(digits.slice(0, 2));
}
