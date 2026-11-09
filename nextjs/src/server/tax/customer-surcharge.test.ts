// Vectors are the expectations of spec/controllers/customer_surcharge_controller_spec.rb ("returns the correct non-zero
// tax value when buyer location is EU...", "an invalid VAT ID status", "tax as 0 when ... a valid VAT ID", "returns 0
// if price input is invalid", the 400 cases) and spec/business/sales_tax/sales_tax_calculation_spec.rb.
import { describe, expect, it } from "vitest";

import { calculateWithLookup, oneTimeChargeTotalCents, surchargeTotals, validProductsParam, type LookupInput } from "./customer-surcharge.ts";
import { zeroTax } from "./sales-tax-calculation.ts";

const de: LookupInput = { priceCents: 100, buyerVatIdPresent: false, vatIdValid: false, sellerHasBrazilianConnectAccount: false, rate: { country: "DE", combinedRate: "0.1900000" }, taxEligible: true, isQuebec: false };
const line = (input: LookupInput) => ({ taxResult: calculateWithLookup(input), shippingUsdCents: 0 });

describe("surchargeTotals (CustomerSurchargeController#calculate_all)", () => {
  it("adds 19 cents of German VAT to a 100 cent product and offers a VAT id input", () => {
    expect(surchargeTotals([line(de)])).toEqual({ vat_id_valid: false, has_vat_id_input: true, shipping_rate_cents: 0, tax_cents: 19, tax_included_cents: 0, subtotal: 100 });
  });

  it("keeps the tax and reports an invalid VAT id as not valid", () => {
    const totals = surchargeTotals([line({ ...de, buyerVatIdPresent: true })]);
    expect(totals).toMatchObject({ vat_id_valid: false, has_vat_id_input: true, tax_cents: 19, subtotal: 100 });
  });

  it("charges no tax and reports the VAT id as valid for a valid business VAT id", () => {
    expect(surchargeTotals([line({ ...de, vatIdValid: true, buyerVatIdPresent: true })])).toEqual({ vat_id_valid: true, has_vat_id_input: false, shipping_rate_cents: 0, tax_cents: 0, tax_included_cents: 0, subtotal: 100 });
  });

  it("returns zeros for a price of 0 (an invalid price reads as 0)", () => {
    expect(surchargeTotals([line({ ...de, priceCents: 0 })])).toEqual({ vat_id_valid: false, has_vat_id_input: false, shipping_rate_cents: 0, tax_cents: 0, tax_included_cents: 0, subtotal: 0 });
  });

  it("returns zeros for an empty cart", () => {
    expect(surchargeTotals([])).toEqual({ vat_id_valid: false, has_vat_id_input: false, shipping_rate_cents: 0, tax_cents: 0, tax_included_cents: 0, subtotal: 0 });
  });

  it("sums shipping, subtotal and tax over lines and lets the last line decide vat_id_valid", () => {
    const totals = surchargeTotals([
      { taxResult: calculateWithLookup({ ...de, priceCents: 1000, vatIdValid: true, buyerVatIdPresent: true }), shippingUsdCents: 20 },
      { taxResult: calculateWithLookup({ ...de, priceCents: 1000 }), shippingUsdCents: 30 },
    ]);
    expect(totals).toEqual({ vat_id_valid: false, has_vat_id_input: true, shipping_rate_cents: 50, tax_cents: 190, tax_included_cents: 0, subtotal: 2000 });
    expect(oneTimeChargeTotalCents(totals)).toBe(2240);
  });
});

describe("calculateWithLookup (SalesTaxCalculator#calculate)", () => {
  it("rounds the tax with lookupTaxCents (half up on the product of cents and rate)", () => {
    expect(calculateWithLookup({ ...de, priceCents: 1050, rate: { country: "DE", combinedRate: "0.1900000" } }).taxCents).toBe(200); // 199.5
  });

  it("collects nothing when the rate is not eligible or absent, or the seller has a Brazilian Connect account", () => {
    expect(calculateWithLookup({ ...de, taxEligible: false })).toEqual(zeroTax(100));
    expect(calculateWithLookup({ ...de, rate: null })).toEqual(zeroTax(100));
    expect(calculateWithLookup({ ...de, sellerHasBrazilianConnectAccount: true })).toEqual(zeroTax(100));
  });
});

describe("validProductsParam", () => {
  it("rejects a string and an array of strings, accepts an array of hashes", () => {
    expect(validProductsParam("not-an-array")).toBe(false);
    expect(validProductsParam(["abc"])).toBe(false);
    expect(validProductsParam([{ permalink: "abc", price: 100, quantity: 1 }])).toBe(true);
    expect(validProductsParam([])).toBe(true);
  });
});
