import { describe, expect, it } from "vitest";

import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";
import { paymentTypeLabel, PURCHASE_FIELDS, purchaseExportCsv, zipCodeForExport } from "./purchase-export.ts";

describe("purchase export pure helpers", () => {
  it("labels the non-card payment types and charges everything else as a card", () => {
    expect(paymentTypeLabel("paypal")).toBe("PayPal");
    expect(paymentTypeLabel("ideal")).toBe("iDEAL");
    expect(paymentTypeLabel("visa")).toBe("Card");
    expect(paymentTypeLabel("")).toBeUndefined();
    expect(paymentTypeLabel(null)).toBeUndefined();
  });

  it("pads zip codes to five characters and leaves a missing zip missing", () => {
    expect(zipCodeForExport("1234")).toBe("01234");
    expect(zipCodeForExport("90210")).toBe("90210");
    expect(zipCodeForExport(null)).toBeNull();
  });
});

describe("purchase export compile", () => {
  const row = (overrides: Record<string, unknown>, customFields: Record<string, string> = {}) => ({
    fields: { "Purchase ID": "abc", "Sale Price ($)": new RubyFloat(10), "Subtotal ($)": new RubyFloat(8.5), ...overrides },
    customFields,
  });

  it("writes the purchase columns, then custom fields, then a Totals row", () => {
    const csv = purchaseExportCsv(["Size"], [row({}, { Size: "L" })]);
    const [header, data, totals] = csv.trimEnd().split("\n");
    expect(header!.split(",")).toEqual([...PURCHASE_FIELDS, "Size"]);
    expect(data!.split(",")[0]).toBe("abc");
    expect(data!.split(",").at(-1)).toBe("L");
    expect(totals!.split(",")[0]).toBe("Totals");
    expect(totals!.split(",")[PURCHASE_FIELDS.indexOf("Sale Price ($)")]).toBe("10.0");
    expect(totals!.split(",")[PURCHASE_FIELDS.indexOf("Subtotal ($)")]).toBe("8.5");
  });

  it("sums totals columns across rows as Floats rounded to cents", () => {
    const csv = purchaseExportCsv([], [row({ "Sale Price ($)": new RubyFloat(0.1) }), row({ "Sale Price ($)": new RubyFloat(0.2) })]);
    const totals = csv.trimEnd().split("\n").at(-1)!.split(",");
    expect(totals[PURCHASE_FIELDS.indexOf("Sale Price ($)")]).toBe("0.3");
  });
});
