import { describe, expect, it } from "vitest";

import { csvSafeLine } from "../../lib/csv-safe.ts";
import {
  annotatePayoutDeductionRow,
  calculateTotals,
  PAYOUT_HEADERS,
  PAYPAL_PAYOUTS_NOTE,
  PAYPAL_PAYOUTS_HEADING,
  PAYPAL_SALES_SUBTOTAL_HEADING,
  partialRefundSummary,
  payoutCsv,
  processorDeductionSummary,
  type SaleFacts,
  saleSummary,
  sortPayoutRows,
  subtotalRows,
  technicalAdjustmentRow,
  CARD_SALES_SUBTOTAL_HEADING,
} from "./payouts-csv.ts";

const sale: SaleFacts = {
  externalId: "abc",
  linkName: "Product",
  fullName: "Jane Doe",
  buyerEmail: "jane@example.com",
  taxDollars: 0,
  shippingDollars: 0,
  priceDollars: 10,
  feeDollars: 1,
  netTotal: 9,
  paymentCents: 900,
  feeWaivedOnRefund: false,
};

describe("payouts CSV", () => {
  it("has the eleven payout columns", () => {
    expect(PAYOUT_HEADERS).toHaveLength(11);
    expect(PAYOUT_HEADERS[10]).toBe("Net Total ($)");
  });

  it("writes a sale with its money as Floats and its empty columns as empty strings", () => {
    const { row, deltaCents } = saleSummary(sale, "2025-01-02");
    expect(csvSafeLine(row)).toBe(`Sale,2025-01-02,abc,Product,Jane Doe,jane@example.com,0.0,0.0,10.0,1.0,9.0\n`);
    expect(deltaCents).toBe(900);
  });

  it("nets a partial refund's fee and debit into the running total", () => {
    const { row, deltaCents } = partialRefundSummary(
      {
        refund: { createdOn: "2025-01-03", amountCents: 1000, feeCents: 30, creatorTaxCents: 0, retainedFeeCents: 0 },
        issuedAmountGrossCents: -1000,
        issuedAmountNetCents: -800,
      },
      sale,
    );
    expect(csvSafeLine(row)).toBe(
      "Partial Refund,2025-01-03,abc,Product,Jane Doe,jane@example.com,-0.0,-0.0,-10.0,-0.3,-8.0\n",
    );
    expect(deltaCents).toBe(-800);
  });

  it("labels a processor deduction and reduces the running total by its amount", () => {
    const { row, deltaCents } = processorDeductionSummary(PAYPAL_PAYOUTS_HEADING, "2025-01-05", 2500);
    expect(row[0]).toBe(PAYPAL_PAYOUTS_HEADING);
    expect(row[8]).toEqual(expect.objectContaining({ value: -25 }));
    expect(deltaCents).toBe(-2500);
  });

  it("writes the processor note into the item name of a deduction row without mutating it", () => {
    const { row } = processorDeductionSummary(PAYPAL_PAYOUTS_HEADING, "2025-01-05", 2500);
    const annotated = annotatePayoutDeductionRow(row);
    expect(annotated[3]).toBe(PAYPAL_PAYOUTS_NOTE);
    expect(row[3]).toBe("");
    expect(annotatePayoutDeductionRow(saleSummary(sale, "2025-01-02").row)).toEqual(saleSummary(sale, "2025-01-02").row);
  });

  it("sorts by date and keeps insertion order within a day", () => {
    const later = saleSummary({ ...sale, externalId: "later" }, "2025-02-01").row;
    const firstSameDay = saleSummary({ ...sale, externalId: "first" }, "2025-01-01").row;
    const secondSameDay = saleSummary({ ...sale, externalId: "second" }, "2025-01-01").row;
    expect(sortPayoutRows([later, firstSameDay, secondSameDay]).map((row) => row[2])).toEqual(["first", "second", "later"]);
  });

  it("returns no adjustment when the balances reconcile, and a Technical Adjustment otherwise", () => {
    expect(technicalAdjustmentRow("2025-01-31", 900, 900)).toBeNull();
    const row = technicalAdjustmentRow("2025-01-31", 1000, 900);
    expect(row?.[0]).toBe("Technical Adjustment");
    expect(row?.[10]).toEqual(expect.objectContaining({ value: 1 }));
  });

  it("sums the totals columns across rows", () => {
    const totals = calculateTotals([saleSummary(sale, "2025-01-02").row, saleSummary(sale, "2025-01-03").row]);
    expect(totals.get("Net Total ($)")).toBe(18);
    expect(totals.get("Sale Price ($)")).toBe(20);
  });

  it("emits subtotals only when the payout mixes groups", () => {
    const gumroadRow = saleSummary(sale, "2025-01-02").row;
    const paypalRow = saleSummary({ ...sale, netTotal: 4, priceDollars: 5, feeDollars: 1 }, "2025-01-02").row;
    expect(subtotalRows([gumroadRow], [], [])).toEqual([]);

    const rows = subtotalRows([gumroadRow, paypalRow], [paypalRow], []);
    expect(rows.map((row) => row[0])).toEqual([CARD_SALES_SUBTOTAL_HEADING, PAYPAL_SALES_SUBTOTAL_HEADING]);
    expect(rows[0]![10]).toEqual(expect.objectContaining({ value: 9 }));
  });

  it("writes headers, annotated rows, subtotals and a Totals row in that order", () => {
    const gumroadRow = saleSummary(sale, "2025-01-02").row;
    const csv = payoutCsv([gumroadRow], [], []);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(PAYOUT_HEADERS.join(","));
    expect(lines[1]).toBe("Sale,2025-01-02,abc,Product,Jane Doe,jane@example.com,0.0,0.0,10.0,1.0,9.0");
    expect(lines[2]).toBe("Totals,,,,,,0.0,0.0,10.0,1.0,9.0");
  });
});
