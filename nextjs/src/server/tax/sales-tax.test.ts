// Vectors are the expectations of the Ruby specs named on each group (spec/lib/utilities/us_zip_codes_spec.rb,
// spec/lib/utilities/compliance_spec.rb, spec/services/oman_vat_number_validation_service_spec.rb,
// spec/business/sales_tax/sales_tax_calculation_spec.rb, spec/controllers/customer_surcharge_controller_spec.rb).
// Groups marked "derived" are not recorded from Ruby (no Ruby in the porting environment): they restate the Ruby source.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bahrainTrn,
  kenyaKraPin,
  nigeriaFirsTin,
  omanVatNumber,
  regionalVatIdValidator,
  tanzaniaTraTin,
} from "./regional-vat-id-shape.ts";
import {
  buyerTaxRegion,
  esVatExemptWithoutGeoIp,
  lookupTaxCents,
  salesTaxCalculationToHash,
  taxEligible,
  zeroBusinessVat,
  zeroTax,
} from "./sales-tax-calculation.ts";
import { esPostalCodeVatExempt, taxNameFor } from "./sales-tax-countries.ts";
import { identifyStateCode } from "./us-zip-codes.ts";

describe("identifyStateCode (UsZipCodes.identify_state_code)", () => {
  it.each([
    ["94104", "CA"],
    ["  94104", "CA"],
    ["94104  ", "CA"],
    ["94104-5401", "CA"],
    ["94104 5401", "CA"],
    ["941045401", "CA"],
    ["9410", null],
    ["94l04", null],
    ["94104-540", null],
    [null, null],
    ["", null],
  ])("maps %j to %j", (zip, state) => {
    expect(identifyStateCode(zip)).toBe(state);
  });

  it("applies KNOWN_ZIP_CODES, which the CSV lacks", () => {
    expect(identifyStateCode("85144")).toBe("AZ");
  });

  it("matches every row of config/zip_code_database.csv", () => {
    const rows = readFileSync(new URL("../../../../config/zip_code_database.csv", import.meta.url), "utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean);
    const expected = new Map(rows.map((row) => row.split(",") as [string, string]));
    expected.set("85144", "AZ");
    expect(expected.size).toBeGreaterThan(40_000);
    for (const [zip, state] of expected) expect(identifyStateCode(zip)).toBe(state);
  });
});

describe("esPostalCodeVatExempt (Compliance.es_postal_code_vat_exempt?)", () => {
  it.each(["35000", "35001", "38001", "38999", "51001", "52001", "52080", " 38400 "])("is true for %j", (code) => {
    expect(esPostalCodeVatExempt(code)).toBe(true);
  });
  it.each(["08001", "28001", "34999", "39000", "3500", "350000", "35", "3500A", " 35001x", null, "", "   "])(
    "is false for %j",
    (code) => {
      expect(esPostalCodeVatExempt(code)).toBe(false);
    },
  );
});

describe("OmanVatNumberValidationService", () => {
  it("accepts OM plus ten digits", () => expect(omanVatNumber("OM1234567890")).toBe(true));
  it.each([null, "   ", "OM123456", "ON1234567890", "om1234567890", "1234567890", "OMABCDEFGHIJ"])(
    "rejects %j",
    (value) => {
      expect(omanVatNumber(value)).toBe(false);
    },
  );
});

describe("other offline tax-id validators (derived from the Ruby source)", () => {
  it("Bahrain TRN is any 15 characters", () => {
    expect(bahrainTrn("123456789012345")).toBe(true);
    expect(bahrainTrn("12345678901234")).toBe(false);
    expect(bahrainTrn("")).toBe(false);
  });
  it("Kenya KRA PIN is letter, nine digits, letter", () => {
    expect(kenyaKraPin("A123456789Z")).toBe(true);
    expect(kenyaKraPin("a123456789Z")).toBe(false);
    expect(kenyaKraPin("A123456789Z\n")).toBe(false);
  });
  it("Nigeria FIRS TIN is 8 digits, hyphen, 4 digits, with Ruby's line anchors", () => {
    expect(nigeriaFirsTin("12345678-1234")).toBe(true);
    expect(nigeriaFirsTin("12345678-1234\nignored")).toBe(true);
    expect(nigeriaFirsTin("1234567-1234")).toBe(false);
  });
  it("Tanzania TRA TIN is two digits, six digits, letter", () => {
    expect(tanzaniaTraTin("12-123456-A")).toBe(true);
    expect(tanzaniaTraTin("12-123456-a")).toBe(false);
  });
});

describe("regionalVatIdValidator routing (derived from RegionalVatIdValidationService)", () => {
  it.each([
    ["AU", null, "AbnValidationService"],
    ["SG", null, "GstValidationService"],
    ["CA", "QC", "QstValidationService"],
    ["CA", "ON", "VatValidationService"],
    ["NO", null, "MvaValidationService"],
    ["IS", null, "TaxIdValidationService"],
    ["IN", null, "TaxIdValidationService"],
    ["MY", null, "TaxIdValidationService"],
    ["DE", null, "VatValidationService"],
    [null, null, "VatValidationService"],
  ])("routes %j/%j to %s", (country, state, service) => {
    expect(regionalVatIdValidator(country, state)).toEqual({ kind: "remote", service });
  });
  it.each(["BH", "KE", "NG", "TZ", "OM"])("validates %s offline", (country) => {
    expect(regionalVatIdValidator(country, null).kind).toBe("local");
  });
});

describe("SalesTaxCalculation (spec/business/sales_tax/sales_tax_calculation_spec.rb)", () => {
  it("zero tax helper", () => {
    expect(zeroTax(100)).toMatchObject({ priceCents: 100, taxCents: 0, zipTaxRateCountry: null });
    expect(salesTaxCalculationToHash(zeroTax(100))).toMatchObject({
      price_cents: 100,
      tax_cents: 0,
      has_vat_id_input: false,
    });
  });
  it("zero business VAT marks the status valid", () => {
    expect(zeroBusinessVat(100).businessVatStatus).toBe("valid");
  });
  it.each([
    ["a default-country rate", "US", 10, false],
    ["an EU country", "IT", 10, true],
    ["Australia", "AU", 10, true],
    ["Singapore", "SG", 8, true],
  ])("serializes %s", (_name, country, taxCents, hasVatIdInput) => {
    const hash = salesTaxCalculationToHash({
      priceCents: 100,
      taxCents,
      zipTaxRateCountry: country,
      businessVatStatus: null,
      isQuebec: false,
    });
    expect(hash).toEqual({
      price_cents: 100,
      tax_cents: taxCents,
      business_vat_status: null,
      has_vat_id_input: hasVatIdInput,
    });
  });
  it("serializes Quebec with no rate", () => {
    expect(
      salesTaxCalculationToHash({
        priceCents: 100,
        taxCents: 8,
        zipTaxRateCountry: null,
        businessVatStatus: null,
        isQuebec: true,
      }).has_vat_id_input,
    ).toBe(true);
  });
});

describe("lookupTaxCents (spec/controllers/customer_surcharge_controller_spec.rb vectors, then derived half-up cases)", () => {
  it.each([
    [100, "0.19", 19],
    [100, "0.1", 10],
    [1000, "0.19", 190],
    [1600, "0.2", 320],
    // derived: BigDecimal#round is half away from zero
    [5, "0.1", 1],
    [4, "0.1", 0],
    [15, "0.1", 2],
    [1, "0.5", 1],
    [999, "0.0825000", 82],
    [0, "0.19", 0],
    [-5, "0.1", -1],
  ])("price %i at rate %s is %i cents", (price, rate, cents) => {
    expect(lookupTaxCents(price, rate)).toBe(cents);
  });
  it("rejects float-style input and over-precise rates", () => {
    expect(() => lookupTaxCents(100, "abc")).toThrow();
    expect(() => lookupTaxCents(100, "0.12345678")).toThrow();
  });
});

describe("buyerTaxRegion and tax eligibility (derived from SalesTaxCalculator)", () => {
  it("resolves a US taxable state from the postal code", () => {
    expect(buyerTaxRegion({ country: "US", postal_code: "10001" })).toEqual({
      state: "NY",
      isUsTaxableState: true,
      isCaTaxable: false,
      isQuebec: false,
    });
  });
  it("treats California as US-known but not taxable", () => {
    expect(buyerTaxRegion({ country: "US", postal_code: "94104" })).toMatchObject({
      state: "CA",
      isUsTaxableState: false,
    });
  });
  it("uses the province for Canada", () => {
    expect(buyerTaxRegion({ country: "CA", state: "QC" })).toMatchObject({ isCaTaxable: true, isQuebec: true });
    expect(buyerTaxRegion({ country: "CA", state: "" })).toMatchObject({ isCaTaxable: false });
  });
  it("exempts Canary Island postal codes and confirmed territories, defers the rest to GeoIP", () => {
    expect(esVatExemptWithoutGeoIp("ES", { postal_code: "35001" })).toBe(true);
    expect(esVatExemptWithoutGeoIp("ES", { vat_exempt_territory: true })).toBe(true);
    expect(esVatExemptWithoutGeoIp("ES", { postal_code: "28001" })).toBeUndefined();
    expect(esVatExemptWithoutGeoIp("DE", { postal_code: "35001" })).toBe(false);
  });

  const base = {
    rateIsSellerOwn: false,
    isPhysical: false,
    region: { isUsTaxableState: false, isCaTaxable: false },
    featureActive: () => false,
    entirelyPhysicalShipment: () => false,
  };
  it("collects EU VAT on digital goods but not on entirely physical shipments into the EU-27", () => {
    expect(taxEligible({ ...base, rateCountry: "DE" })).toBe(true);
    expect(taxEligible({ ...base, rateCountry: "DE", isPhysical: true, entirelyPhysicalShipment: () => true })).toBe(
      false,
    );
    expect(taxEligible({ ...base, rateCountry: "GB", isPhysical: true, entirelyPhysicalShipment: () => true })).toBe(
      true,
    );
    expect(
      taxEligible({ ...base, rateCountry: "DE", rateIsSellerOwn: true, entirelyPhysicalShipment: () => true }),
    ).toBe(true);
  });
  it("gates feature-flagged countries and physical goods", () => {
    expect(taxEligible({ ...base, rateCountry: "JP" })).toBe(false);
    expect(taxEligible({ ...base, rateCountry: "JP", featureActive: (f) => f === "collect_tax_jp" })).toBe(true);
    expect(taxEligible({ ...base, rateCountry: "TH", isPhysical: true, featureActive: () => true })).toBe(false);
    expect(taxEligible({ ...base, rateCountry: "TH", featureActive: (f) => f === "collect_tax_th" })).toBe(true);
    expect(taxEligible({ ...base, rateCountry: "US" })).toBe(false);
    expect(taxEligible({ ...base, rateCountry: "US", isPhysical: true })).toBe(true);
    expect(taxEligible({ ...base, rateCountry: "US", region: { isUsTaxableState: true, isCaTaxable: false } })).toBe(
      true,
    );
  });
});

describe("taxNameFor", () => {
  it.each([
    ["IN", "GST"],
    ["NZ", "GST"],
    ["AU", "GST"],
    ["SG", "GST"],
    ["MY", "Service tax"],
    ["JP", "CT"],
    ["DE", "VAT"],
    ["toString", "VAT"],
  ])("%s is %s", (code, name) => {
    expect(taxNameFor(code)).toBe(name);
  });
});
