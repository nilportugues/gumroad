// Port of the arithmetic of app/controllers/customer_surcharge_controller.rb#calculate_all and of
// SalesTaxCalculator#calculate's lookup-table branch. The route is controllers/customer-surcharge.ts, which serves the carts
// with no FX quote and no direct-listed token and hands the rest back to Rails.
// Callers pass in what needs a database or a vendor: the ZipTaxRate row and the Feature flags.
import {
  lookupTaxCents,
  type BusinessVatStatus,
  type SalesTaxCalculation,
  zeroBusinessVat,
  zeroTax,
  salesTaxCalculationToHash,
} from "./sales-tax-calculation.ts";

export type LookupRate = { country: string; combinedRate: string };

export type LookupInput = {
  priceCents: number;
  /** `buyer_vat_id.present?` */
  buyerVatIdPresent: boolean;
  /** The buyer's VAT id passed RegionalVatIdValidationService. */
  vatIdValid: boolean;
  /** `product.user.has_brazilian_stripe_connect_account?` */
  sellerHasBrazilianConnectAccount: boolean;
  /** The ZipTaxRate the lookup table picked, already past `is_vat_exempt?`; null when none applies. */
  rate: LookupRate | null;
  /** `tax_eligible?` for that rate. */
  taxEligible: boolean;
  isQuebec: boolean;
};

// SalesTaxCalculator#calculate without the TaxJar branch (callers hand back US-taxable-state and Canada buyers).
export function calculateWithLookup(input: LookupInput): SalesTaxCalculation {
  if (input.priceCents === 0) return zeroTax(input.priceCents);
  if (input.sellerHasBrazilianConnectAccount) return zeroTax(input.priceCents);
  if (input.vatIdValid) return zeroBusinessVat(input.priceCents);
  if (input.rate === null || !input.taxEligible) return zeroTax(input.priceCents);

  const businessVatStatus: BusinessVatStatus = input.buyerVatIdPresent ? "invalid" : null;
  return {
    priceCents: input.priceCents,
    taxCents: lookupTaxCents(input.priceCents, input.rate.combinedRate),
    zipTaxRateCountry: input.rate.country,
    businessVatStatus,
    isQuebec: input.isQuebec,
  };
}

export type SurchargeLine = { taxResult: SalesTaxCalculation; shippingUsdCents: number };

export type SurchargeTotals = {
  vat_id_valid: boolean;
  has_vat_id_input: boolean;
  shipping_rate_cents: number;
  tax_cents: number;
  tax_included_cents: number;
  subtotal: number;
};

// The body of the products loop in CustomerSurchargeController#calculate_all: the last line decides `vat_id_valid`,
// any line can raise `has_vat_id_input`, and only a positive tax is added up.
export function surchargeTotals(lines: SurchargeLine[]): SurchargeTotals {
  const totals: SurchargeTotals = {
    vat_id_valid: false,
    has_vat_id_input: false,
    shipping_rate_cents: 0,
    tax_cents: 0,
    tax_included_cents: 0,
    subtotal: 0,
  };
  for (const { taxResult, shippingUsdCents } of lines) {
    totals.vat_id_valid = taxResult.businessVatStatus === "valid";
    totals.has_vat_id_input ||= salesTaxCalculationToHash(taxResult).has_vat_id_input;
    totals.shipping_rate_cents += shippingUsdCents;
    if (taxResult.taxCents > 0) totals.tax_cents += taxResult.taxCents;
    totals.subtotal += taxResult.priceCents;
  }
  return totals;
}

// `charge_canonical_total_cents` for one-time lines: subtotal + tax + shipping. Installment, preorder and commission
// lines charge less than the agreement total now; they are not covered.
export const oneTimeChargeTotalCents = (totals: SurchargeTotals): number =>
  totals.subtotal + totals.tax_cents + totals.shipping_rate_cents;

// CustomerSurchargeController#calculate_all: `products` must be an array of hashes, otherwise 400.
export const validProductsParam = (products: unknown): boolean =>
  Array.isArray(products) &&
  products.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
