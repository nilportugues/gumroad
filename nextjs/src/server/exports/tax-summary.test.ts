import { describe, expect, it } from "vitest";

import {
  annualTaxSummaryFilename,
  balanceTransactionWindow,
  formatCents,
  PAYABLE_HEADERS,
  type PayableSummary,
  payableIsReportable,
  payableRow,
  platformChargeId,
  transactionReportCsv,
} from "./tax-summary.ts";

// Cases from spec/services/exports/tax_summary/transaction_report_spec.rb.
describe("1099-K transaction report", () => {
  const march10 = Date.UTC(2025, 2, 10) / 1000;
  const march12 = Date.UTC(2025, 2, 12) / 1000;
  const jan2 = Date.UTC(2025, 0, 2) / 1000;
  const dec31 = Date.UTC(2024, 11, 31) / 1000;

  it("writes one row per transaction in funds-available order, with a total", () => {
    const csv = transactionReportCsv(
      [
        { created: march10, availableOn: march12, chargeId: "ch_matched", amountCents: 1080 },
        { created: dec31, availableOn: jan2, chargeId: "ch_orphan", amountCents: 500 },
      ],
      new Map([["ch_matched", [{ externalId: "abc", priceCents: 1000, gumroadTaxCents: 80 }]]]),
    );
    expect(csv).toBe(
      [
        "Charge date (UTC),Funds available date (UTC),Stripe payment ID,Gumroad sale ID,Product price ($),Sales tax collected ($),Amount ($)",
        "2024-12-31,2025-01-02,ch_orphan,,,,5.00",
        "2025-03-10,2025-03-12,ch_matched,abc,10.00,0.80,10.80",
        "Total,,,,,,15.80",
        "",
      ].join("\n"),
    );
  });

  it("combines every sale sharing a charge into one row", () => {
    const csv = transactionReportCsv(
      [{ created: march10, availableOn: march12, chargeId: "ch_matched", amountCents: 1620 }],
      new Map([
        [
          "ch_matched",
          [
            { externalId: "abc", priceCents: 1000, gumroadTaxCents: 80 },
            { externalId: "def", priceCents: 500, gumroadTaxCents: 40 },
          ],
        ],
      ]),
    );
    expect(csv.split("\n")[1]).toBe("2025-03-10,2025-03-12,ch_matched,abc; def,15.00,1.20,16.20");
  });

  it("leaves the Gumroad columns blank for a charge with no successful sale", () => {
    const csv = transactionReportCsv([{ created: march10, availableOn: march12, chargeId: "ch_failed", amountCents: 1080 }], new Map());
    expect(csv.split("\n")[1]).toBe("2025-03-10,2025-03-12,ch_failed,,,,10.80");
  });

  it("formats cents with two decimals", () => {
    expect(formatCents(1080)).toBe("10.80");
    expect(formatCents(-500)).toBe("-5.00");
    expect(formatCents(0)).toBe("0.00");
  });

  it("sanitizes a sale ID that starts with a dash, as the spec's helper expects", () => {
    const csv = transactionReportCsv(
      [{ created: march10, availableOn: march12, chargeId: "ch_x", amountCents: 1000 }],
      new Map([["ch_x", [{ externalId: "-abc", priceCents: 1000, gumroadTaxCents: null }]]]),
    );
    expect(csv.split("\n")[1]).toBe("2025-03-10,2025-03-12,ch_x,'-abc,10.00,0.00,10.00");
  });
});

describe("platform charge lookup", () => {
  it("returns a direct charge's own source", () => {
    expect(platformChargeId("ch_matched")).toBe("ch_matched");
  });

  it("follows a transferred payment back to the platform charge", () => {
    expect(
      platformChargeId({ id: "py_ch_matched", source_transfer: { source_transaction: "ch_matched" } }),
    ).toBe("ch_matched");
  });

  it("falls back to the source's own ID when there is no transfer", () => {
    expect(platformChargeId({ id: "py_only", source_transfer: null })).toBe("py_only");
  });
});

describe("tax summary windows and names", () => {
  it("bounds a tax year by UTC midnights, end exclusive", () => {
    expect(balanceTransactionWindow(2025)).toEqual({ gte: 1735689600, lt: 1767225600 });
  });

  it("names the annual file with strftime %W, where weeks start on Monday", () => {
    expect(annualTaxSummaryFilename(2025, "uuid", new Date("2025-01-01T12:00:00Z"))).toBe("annual_exports_2025_uuid-00.csv");
    expect(annualTaxSummaryFilename(2025, "uuid", new Date("2025-01-06T12:00:00Z"))).toBe("annual_exports_2025_uuid-01.csv");
  });
});

describe("Payable row", () => {
  const summary: PayableSummary = {
    transactionCentsByMonth: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 123456],
    totalTransactionCents: 123456,
    transactionsCount: 3,
  };

  it("is reportable only with completed compliance and taxable volume", () => {
    expect(payableIsReportable(true, summary)).toBe(true);
    expect(payableIsReportable(false, summary)).toBe(false);
    expect(payableIsReportable(true, { ...summary, totalTransactionCents: 0 })).toBe(false);
  });

  it("lines up with the header and carries the monthly amounts in dollars", () => {
    const row = payableRow({
      externalId: "ext",
      stripeId: null,
      firstAndLastName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      legalEntityName: null,
      email: "jane@example.com",
      legalEntityStreetAddress: null,
      legalEntityCity: null,
      legalEntityStateCode: "CA",
      legalEntityZipCode: null,
      legalEntityCountryCode: "US",
      legalEntityPayableBusinessType: null,
      personalTaxId: "",
      businessTaxId: null,
      summary,
    });
    expect(row).toHaveLength(PAYABLE_HEADERS.length);
    expect(row[1]).toBe("ext");
    expect(row[15]).toBeNull();
    expect(row[21]).toEqual(expect.objectContaining({ value: 1234.56 }));
    expect(row[24]).toBe(3);
    expect(row[37]).toEqual(expect.objectContaining({ value: 1234.56 }));
    expect(row.at(-1)).toBeNull();
  });
});
