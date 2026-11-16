import { describe, expect, it } from "vitest";

import { countryAlpha2, legalEntityCountryCode, guardianHasCompletedInfo, legalGuardianRequirementMet, legalGuardianUnsupported, nativePayoutsSupported, noPayoutRailInComplianceCountry, observedUtcOffset, tzinfoName } from "./data.ts";
import type { ComplianceInfoRow, GuardianRow } from "./reads.ts";

const info = (attributes: Partial<ComplianceInfoRow> = {}): ComplianceInfoRow => ({ country: "United States", business_country: null, is_business: false, birthday: null, guardian_id: null, ...attributes });

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

  it("matches names the way Compliance::Countries.find_by_name normalizes them", () => {
    expect(countryAlpha2("Cote d'Ivoire")).toBe("CI");
    expect(countryAlpha2("Curacao")).toBe("CW");
    expect(countryAlpha2("Korea Republic of")).toBe("KR");
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
    const guardian = (attributes: Partial<GuardianRow> = {}): GuardianRow => ({
      first_name: "Pat",
      last_name: "Parent",
      email: "pat@example.com",
      date_of_birth: new Date("1980-01-01T00:00:00Z"),
      street_address: "1 Main St",
      city: "Springfield",
      state: "IL",
      zip_code: "62701",
      country: "United States",
      country_code: "US",
      individual_tax_id: new Uint8Array([1, 2, 3]),
      stripe_tos_accepted: 1,
      stripe_tos_accepted_at: new Date("2026-10-01T00:00:00Z"),
      stripe_tos_ip: "203.0.113.9",
      deleted_at: null,
      ...attributes,
    });

    it("needs no guardian for an adult or an unknown birthday", () => {
      expect(legalGuardianRequirementMet(info({ birthday: new Date("1990-01-01T00:00:00Z") }), null, now)).toBe(true);
      expect(legalGuardianRequirementMet(info(), null, now)).toBe(true);
      expect(legalGuardianUnsupported(info({ birthday: new Date("1990-01-01T00:00:00Z") }), now)).toBe(false);
    });

    it("marks a minor in a country with no guardian path unsupported and not ready", () => {
      const brazilian = info({ country: "Brazil", birthday: minor });
      expect(legalGuardianUnsupported(brazilian, now)).toBe(true);
      expect(legalGuardianRequirementMet(brazilian, null, now)).toBe(false);
    });

    it("asks a US minor for a complete guardian", () => {
      const american = info({ birthday: minor });
      expect(legalGuardianRequirementMet(american, null, now)).toBe(false);
      expect(legalGuardianRequirementMet(american, guardian(), now)).toBe(true);
      expect(legalGuardianRequirementMet(american, guardian({ first_name: "  " }), now)).toBe(false);
    });

    it("holds a guardian to every field Stripe asks for", () => {
      expect(guardianHasCompletedInfo(guardian())).toBe(true);
      for (const missing of [
        { last_name: null },
        { email: "" },
        { date_of_birth: null },
        { street_address: null },
        { city: null },
        { zip_code: null },
        { country: null },
        { individual_tax_id: null },
        { individual_tax_id: new Uint8Array() },
        { stripe_tos_accepted: 0 },
        { stripe_tos_accepted_at: null },
        { stripe_tos_ip: "" },
        { deleted_at: new Date("2026-10-15T00:00:00Z") },
      ] satisfies Partial<GuardianRow>[]) {
        expect(guardianHasCompletedInfo(guardian(missing)), JSON.stringify(missing)).toBe(false);
      }
    });

    it("asks for a state only where Stripe has a subdivision list", () => {
      expect(guardianHasCompletedInfo(guardian({ state: null }))).toBe(false);
      expect(guardianHasCompletedInfo(guardian({ state: null, country: "France", country_code: "FR" }))).toBe(true);
      // country_code is filled in by a before_validation hook; the country name decides without it.
      expect(guardianHasCompletedInfo(guardian({ state: null, country_code: null }))).toBe(false);
    });
  });
});
