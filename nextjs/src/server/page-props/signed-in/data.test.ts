import { describe, expect, it } from "vitest";

import { countryAlpha2, legalEntityCountryCode, legalGuardianRequirementMet, legalGuardianUnsupported, nativePayoutsSupported, noPayoutRailInComplianceCountry, observedUtcOffset, tzinfoName } from "./data.ts";
import type { ComplianceInfoRow } from "./reads.ts";

const info = (attributes: Partial<ComplianceInfoRow> = {}): ComplianceInfoRow => ({ country: "United States", business_country: null, is_business: false, birthday: null, ...attributes });

describe("time zones", () => {
  it("maps Rails zone names to tzinfo identifiers and passes identifiers through", () => {
    expect(tzinfoName("Pacific Time (US & Canada)")).toBe("America/Los_Angeles");
    expect(tzinfoName("Kolkata")).toBe("Asia/Kolkata");
    expect(tzinfoName("Europe/Paris")).toBe("Europe/Paris");
    expect(tzinfoName("Nowhere/Land")).toBeNull();
  });

  it("reports the offset in force at the given time, daylight saving included", () => {
    expect(observedUtcOffset("America/Los_Angeles", new Date("2026-07-01T12:00:00Z"))).toBe(-7 * 3600);
    expect(observedUtcOffset("America/Los_Angeles", new Date("2026-12-01T12:00:00Z"))).toBe(-8 * 3600);
    expect(observedUtcOffset("Asia/Kolkata", new Date("2026-07-01T12:00:00Z"))).toBe(5.5 * 3600);
    expect(observedUtcOffset("UTC", new Date("2026-07-01T12:00:00Z"))).toBe(0);
  });
});

describe("compliance rules", () => {
  it("finds a country by any of its names", () => {
    expect(countryAlpha2("United States")).toBe("US");
    expect(countryAlpha2("united kingdom")).toBe("GB");
    expect(countryAlpha2("")).toBeNull();
    expect(countryAlpha2("Atlantis")).toBeNull();
  });

  it("uses the business country for a business and falls back to the individual's", () => {
    expect(legalEntityCountryCode(info({ is_business: true, business_country: "Canada" }))).toBe("CA");
    expect(legalEntityCountryCode(info({ is_business: true, business_country: null, country: "Japan" }))).toBe("JP");
    expect(legalEntityCountryCode(info({ is_business: false, business_country: "Canada" }))).toBe("US");
  });

  it("supports native payouts in listed countries, and the UAE only for businesses", () => {
    expect(nativePayoutsSupported(null)).toBe(false);
    expect(nativePayoutsSupported(info())).toBe(true);
    expect(nativePayoutsSupported(info({ country: "United Arab Emirates" }))).toBe(false);
    expect(nativePayoutsSupported(info({ country: "United Arab Emirates", business_country: "United Arab Emirates", is_business: true }))).toBe(true);
  });

  it("flags a country with neither a native nor a PayPal payout rail", () => {
    expect(noPayoutRailInComplianceCountry(null)).toBe(false);
    expect(noPayoutRailInComplianceCountry(info())).toBe(false);
    expect(noPayoutRailInComplianceCountry(info({ country: "Zambia" }))).toBe(true);
    // Outlying areas register under the US at PayPal.
    expect(noPayoutRailInComplianceCountry(info({ country: "Guam" }))).toBe(false);
  });

  describe("legal guardians", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const minor = new Date("2012-01-01T00:00:00Z");

    it("needs no guardian for an adult or an unknown birthday", () => {
      expect(legalGuardianRequirementMet(info({ birthday: new Date("1990-01-01T00:00:00Z") }), now)).toBe(true);
      expect(legalGuardianRequirementMet(info(), now)).toBe(true);
      expect(legalGuardianUnsupported(info({ birthday: new Date("1990-01-01T00:00:00Z") }), now)).toBe(false);
    });

    it("marks a minor in a country with no guardian path unsupported and not ready", () => {
      const brazilian = info({ country: "Brazil", birthday: minor });
      expect(legalGuardianUnsupported(brazilian, now)).toBe(true);
      expect(legalGuardianRequirementMet(brazilian, now)).toBe(false);
    });

    it("refuses to guess about a US minor's guardian", () => {
      expect(() => legalGuardianRequirementMet(info({ birthday: minor }), now)).toThrow(/Guardian/);
    });
  });
});
