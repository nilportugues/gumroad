import { describe, expect, it } from "vitest";

import {
  affiliateExportCsv,
  affiliateExportFilename,
  type AffiliateRow,
  rubyInspectStrings,
  runsSynchronously,
} from "./affiliate-export.ts";

const base: AffiliateRow = {
  externalIdNumeric: 42,
  name: "Affiliate 1",
  username: "aff",
  email: "affiliate@example.com",
  affiliatePercentage: 10,
  salesCents: 1000,
  productNames: ["Product 1"],
  referralUrl: "https://example.com/r/abc",
  destinationUrl: "https://example.com/p",
  createdOn: "2025-01-03",
};

describe("affiliate export", () => {
  it("names the file after the seller username and the UTC timestamp", () => {
    expect(affiliateExportFilename("seller", new Date("2025-01-02T03:04:05Z"))).toBe("Affiliates-seller_2025-01-02-03-04-05.csv");
  });

  it("writes Products as an Array#to_s string and fees as a percent", () => {
    const [header, data] = affiliateExportCsv([base]).split("\n");
    expect(header).toBe(
      "Affiliate ID,Name,Email,Fee,Products,Sales ($),Referral URL,Destination URL,Created At",
    );
    expect(data).toBe(
      `42,Affiliate 1,affiliate@example.com,10 %,"[""Product 1""]",10.00,https://example.com/r/abc,https://example.com/p,2025-01-03`,
    );
  });

  it("falls back to the username when the name is blank", () => {
    const csv = affiliateExportCsv([{ ...base, name: "   " }]);
    expect(csv.split("\n")[1]!.split(",")[1]).toBe("aff");
  });

  it("totals sales in cents, so amounts past a thousand are not truncated", () => {
    const csv = affiliateExportCsv([base, { ...base, externalIdNumeric: 43, salesCents: 123456 }]);
    const rows = csv.trimEnd().split("\n");
    expect(rows[1]!.split(",")[5]).toBe("10.00");
    expect(rows[2]).toContain(`,"1,234.56",`);
    expect(rows.at(-1)).toBe(`Totals,,,,,"1,244.56",,,`);
  });

  it("decides synchronously only when the live count is within the threshold", () => {
    expect(runsSynchronously(2, 2)).toBe(true);
    expect(runsSynchronously(3, 2)).toBe(false);
  });

  it("inspects strings with Ruby's Array#inspect shape", () => {
    expect(rubyInspectStrings([])).toBe("[]");
    expect(rubyInspectStrings(["A", 'B"'])).toBe(`["A", "B\\""]`);
  });
});
