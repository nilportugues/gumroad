// Port of the pure parts of app/business/sales_tax/sales_tax_calculation.rb and sales_tax_calculator.rb. Not ported
// (hand back): the TaxJar branch, ZipTaxRate row selection, GeoIP lookup for the ES exemption, VAT id vendors,
// Feature flag reads and the bundle query behind `entirely_physical_shipment?`. Callers pass those in as inputs.
import {
  COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS,
  COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS,
  EU_VAT_APPLICABLE_COUNTRY_CODES,
  EU_VAT_DESTINATION_COUNTRY_CODES,
  GST_APPLICABLE_COUNTRY_CODES,
  NORWAY_VAT_APPLICABLE_COUNTRY_CODES,
  QUEBEC,
  esPostalCodeVatExempt,
  isTaxableState,
} from "./sales-tax-countries.ts";
import { identifyStateCode } from "./us-zip-codes.ts";

export type BusinessVatStatus = "valid" | "invalid" | null;

export type SalesTaxCalculation = {
  priceCents: number;
  taxCents: number;
  /** Country of the ZipTaxRate used, or null when none (zero tax, TaxJar). */
  zipTaxRateCountry: string | null;
  businessVatStatus: BusinessVatStatus;
  isQuebec: boolean;
};

export const zeroTax = (priceCents: number): SalesTaxCalculation => ({ priceCents, taxCents: 0, zipTaxRateCountry: null, businessVatStatus: null, isQuebec: false });
export const zeroBusinessVat = (priceCents: number): SalesTaxCalculation => ({ ...zeroTax(priceCents), businessVatStatus: "valid" });

// SalesTaxCalculation#has_vat_id_input?
function hasVatIdInput(calculation: SalesTaxCalculation): boolean {
  const country = calculation.zipTaxRateCountry;
  return (
    calculation.isQuebec ||
    (country != null &&
      (EU_VAT_APPLICABLE_COUNTRY_CODES.includes(country) ||
        GST_APPLICABLE_COUNTRY_CODES.includes(country) ||
        NORWAY_VAT_APPLICABLE_COUNTRY_CODES.includes(country) ||
        COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.includes(country) ||
        COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS.includes(country)))
  );
}

// SalesTaxCalculation#to_hash
export const salesTaxCalculationToHash = (calculation: SalesTaxCalculation) => ({
  price_cents: calculation.priceCents,
  tax_cents: calculation.taxCents,
  business_vat_status: calculation.businessVatStatus,
  has_vat_id_input: hasVatIdInput(calculation),
});

const RATE_SCALE_DIGITS = 7; // zip_tax_rates.combined_rate is decimal(8,7)
const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DIGITS);

/**
 * `(price_cents * tax_rate.combined_rate).round`: BigDecimal arithmetic, rounded half away from zero to whole cents.
 * The rate is the column's decimal string (e.g. "0.1900000"); floats are not accepted so no binary error creeps in.
 */
export function lookupTaxCents(priceCents: number, combinedRate: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(combinedRate.trim());
  if (!match) throw new Error(`combinedRate must be a decimal string, got ${JSON.stringify(combinedRate)}`);
  const fraction = (match[3] ?? "").padEnd(RATE_SCALE_DIGITS, "0");
  if (fraction.length > RATE_SCALE_DIGITS && /[1-9]/u.test(fraction.slice(RATE_SCALE_DIGITS))) {
    throw new Error("combinedRate has more precision than decimal(8,7)");
  }
  const scaledRate = BigInt(`${match[2]}${fraction.slice(0, RATE_SCALE_DIGITS)}`) * (match[1] ? -1n : 1n);
  const product = BigInt(priceCents) * scaledRate;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + RATE_SCALE / 2n) / RATE_SCALE; // half up on the magnitude == ROUND_HALF_UP
  return Number(negative ? -rounded : rounded);
}

export type BuyerLocation = { country?: string | null; postal_code?: string | null; state?: string | null; vat_exempt_territory?: boolean | null };

export type BuyerTaxRegion = { state: string | null; isUsTaxableState: boolean; isCaTaxable: boolean; isQuebec: boolean };

// SalesTaxCalculator#initialize: how the buyer's location maps to a US state / Canadian province.
export function buyerTaxRegion(location: BuyerLocation): BuyerTaxRegion {
  const state = location.country === "US" ? identifyStateCode(location.postal_code) : location.country === "CA" ? (location.state ?? null) : null;
  const present = state != null && !/^[\s\u0085]*$/u.test(state);
  const isUsTaxableState = location.country === "US" && present && isTaxableState(state);
  const isCaTaxable = location.country === "CA" && present;
  return { state, isUsTaxableState, isCaTaxable, isQuebec: isCaTaxable && state === QUEBEC };
}

/**
 * SalesTaxCalculator#is_vat_exempt? for the checks that need no network: Spanish territories outside the EU VAT area.
 * Returns undefined when the rows' answer depends on a GeoIP lookup of the buyer's IP, which stays in Rails.
 */
export function esVatExemptWithoutGeoIp(rateCountry: string, location: BuyerLocation): boolean | undefined {
  if (rateCountry !== "ES") return false;
  if (location.vat_exempt_territory) return true;
  if (esPostalCodeVatExempt(location.postal_code)) return true;
  return undefined;
}

export type TaxEligibilityInput = {
  rateCountry: string;
  /** ZipTaxRate#user_id.present?: the seller's own rate. */
  rateIsSellerOwn: boolean;
  isPhysical: boolean;
  region: Pick<BuyerTaxRegion, "isUsTaxableState" | "isCaTaxable">;
  /** `Feature.active?("collect_tax_#{country.downcase}")` */
  featureActive: (flag: string) => boolean;
  /** `entirely_physical_shipment?`; only called for EU-27 destinations, as Rails queries bundles lazily. */
  entirelyPhysicalShipment: () => boolean;
};

// SalesTaxCalculator#eu_import_vat_unremittable?
export function euImportVatUnremittable(input: Pick<TaxEligibilityInput, "rateCountry" | "rateIsSellerOwn" | "entirelyPhysicalShipment">): boolean {
  if (input.rateIsSellerOwn) return false;
  if (!EU_VAT_DESTINATION_COUNTRY_CODES.includes(input.rateCountry)) return false;
  return input.entirelyPhysicalShipment();
}

// SalesTaxCalculator#tax_eligible?
export function taxEligible(input: TaxEligibilityInput): boolean {
  if (euImportVatUnremittable(input)) return false;
  const { rateCountry: country } = input;
  const flag = (code: string) => input.featureActive(`collect_tax_${code.toLowerCase()}`);

  return (
    (input.isPhysical && country === "US") ||
    EU_VAT_APPLICABLE_COUNTRY_CODES.includes(country) ||
    country === "AU" ||
    country === "SG" ||
    country === "NO" ||
    COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.some((code) => country === code && flag(code)) ||
    COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS.some((code) => country === code && !input.isPhysical && flag(code)) ||
    input.region.isUsTaxableState ||
    input.region.isCaTaxable ||
    input.rateIsSellerOwn
  );
}
