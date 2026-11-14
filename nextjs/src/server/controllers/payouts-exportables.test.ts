import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { selectedYearFor } from "./payouts-exportables.ts";

const YEARS = [2024, 2023, 2022];

describe("Payouts::ExportablesController#index year selection", () => {
  it("takes the requested year when the seller has payouts in it", () => {
    expect(selectedYearFor(YEARS, "2023")).toBe(2023);
  });

  it("falls back to the latest year for an absent, empty or unknown year", () => {
    for (const year of [undefined, null, "", "abc", "2021", "0", "-2023", "99999999999999999999"])
      expect(selectedYearFor(YEARS, year)).toBe(2024);
  });

  it("reads the leading digits like String#to_i", () => {
    expect(selectedYearFor(YEARS, " 2022abc")).toBe(2022);
    expect(selectedYearFor(YEARS, "2_023")).toBe(2023);
  });

  it("hands back a year that is an array or a hash", () => {
    expect(() => selectedYearFor(YEARS, ["2023"])).toThrow(HandBackToRails);
    expect(() => selectedYearFor(YEARS, { a: "2023" })).toThrow(HandBackToRails);
  });
});
