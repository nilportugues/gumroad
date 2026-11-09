// Port of app/services/exports/payouts/csv.rb (the CSV layout, subtotals, totals) and the row summarizers of
// app/services/exports/payouts/base.rb. Each summarizer returns its row and the amount it adds to the Ruby
// @running_total, so the caller keeps the same running sum the Ruby does.
// Not ported: payout_data's walk over balances, credits and the PayPal/Stripe Connect queries (they are the
// job path, WS-30 and WS-23), plus the Credit, refund-fee and affiliate-fee-date branches.
import { csvSafeGenerate, type CsvCell } from "../../lib/csv-safe.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { rubyToF } from "../../lib/ruby-to-f.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export const PAYOUT_HEADERS: readonly string[] = [
  "Type", "Date", "Purchase ID", "Item Name", "Buyer Name", "Buyer Email", "Taxes ($)", "Shipping ($)", "Sale Price ($)", "Gumroad Fees ($)", "Net Total ($)",
];
export const PAYOUT_TOTALS_COLUMN_NAME = "Totals";
export const PAYOUT_TOTALS_FIELDS: readonly string[] = ["Taxes ($)", "Shipping ($)", "Sale Price ($)", "Gumroad Fees ($)", "Net Total ($)"];

export const PAYPAL_PAYOUTS_HEADING = "PayPal Payouts";
export const STRIPE_CONNECT_PAYOUTS_HEADING = "Stripe Connect Payouts";

// ASCII and comma-free on purpose: sellers re-parse these files with a comma delimiter, and a comma inside a
// heading shifts the subtotal row out of its columns.
export const CARD_SALES_SUBTOTAL_HEADING = "Subtotal - activity paid out by Gumroad";
export const PAYPAL_SALES_SUBTOTAL_HEADING = "Subtotal - PayPal sales (paid out by PayPal; nets to zero here)";
export const STRIPE_CONNECT_SALES_SUBTOTAL_HEADING = "Subtotal - Stripe Connect sales (paid out by Stripe; nets to zero here)";

export const PAYPAL_PAYOUTS_NOTE =
  "PayPal sales (and their Gumroad fees) are settled by PayPal directly; this line removes their net amount so they don't count toward this payout.";
export const STRIPE_CONNECT_PAYOUTS_NOTE =
  "Stripe Connect sales (and their Gumroad fees) are settled by Stripe directly; this line removes their net amount so they don't count toward this payout.";

const CENTS_PER_DOLLAR = 100;
const MONEY_DECIMALS = 2;
const TYPE_COLUMN = PAYOUT_HEADERS.indexOf("Type");
const DATE_COLUMN = PAYOUT_HEADERS.indexOf("Date");
const ITEM_NAME_COLUMN = PAYOUT_HEADERS.indexOf("Item Name");
const GUMROAD_FEE_COLUMN = PAYOUT_HEADERS.indexOf("Gumroad Fees ($)");
const NET_TOTAL_COLUMN = PAYOUT_HEADERS.indexOf("Net Total ($)");

export type PayoutRow = CsvCell[];
export type Totals = Map<string, number>;

// The summarizers write "" to the columns they leave empty.
function emptyRow(): PayoutRow {
  return PAYOUT_HEADERS.map(() => "");
}

// Dollar amounts stay Floats in the output; ints are written as Ruby writes them.
const dollars = (cents: number): RubyFloat => new RubyFloat(cents / CENTS_PER_DOLLAR);
const rounded = (value: number): RubyFloat => new RubyFloat(rubyRoundHalfUp(value, MONEY_DECIMALS));
const negated = (value: number): RubyFloat => new RubyFloat(-value);

export function calculateTotals(rows: readonly PayoutRow[], fromTotals: Totals = new Map()): Totals {
  const totals = new Map(fromTotals);
  for (const row of rows) {
    for (const column of PAYOUT_TOTALS_FIELDS) {
      const index = PAYOUT_HEADERS.indexOf(column);
      totals.set(column, (totals.get(column) ?? 0) + rubyToF(row[index]));
    }
  }
  return totals;
}

export function generateTotalsRow(totals: Totals, heading: string = PAYOUT_TOTALS_COLUMN_NAME): PayoutRow {
  const row: PayoutRow = PAYOUT_HEADERS.map(() => null);
  row[0] = heading;
  for (const [column, value] of totals) {
    row[PAYOUT_HEADERS.indexOf(column)] = rounded(value);
  }
  return row;
}

// Adds the note to a processor deduction row without touching the shared row it came from.
export function annotatePayoutDeductionRow(row: PayoutRow): PayoutRow {
  const note = row[TYPE_COLUMN] === PAYPAL_PAYOUTS_HEADING ? PAYPAL_PAYOUTS_NOTE
    : row[TYPE_COLUMN] === STRIPE_CONNECT_PAYOUTS_HEADING ? STRIPE_CONNECT_PAYOUTS_NOTE
      : null;
  if (note === null) return row;
  const annotated = [...row];
  annotated[ITEM_NAME_COLUMN] = note;
  return annotated;
}

// One subtotal row per group, only when the payout mixes groups. The Gumroad group is the grand total less
// the PayPal and Stripe Connect groups, so it never depends on which rows are the same objects.
export function subtotalRows(data: readonly PayoutRow[], paypalRows: readonly PayoutRow[], stripeConnectRows: readonly PayoutRow[]): PayoutRow[] {
  if (paypalRows.length === 0 && stripeConnectRows.length === 0) return [];

  const paypalTotals = calculateTotals(paypalRows);
  const stripeTotals = calculateTotals(stripeConnectRows);
  const gumroadTotals: Totals = new Map();
  for (const [column, value] of calculateTotals(data)) {
    gumroadTotals.set(column, value - (paypalTotals.get(column) ?? 0) - (stripeTotals.get(column) ?? 0));
  }

  const rows: PayoutRow[] = [];
  const gumroadRowCount = data.length - paypalRows.length - stripeConnectRows.length;
  if (gumroadRowCount > 0) rows.push(generateTotalsRow(gumroadTotals, CARD_SALES_SUBTOTAL_HEADING));
  if (paypalRows.length > 0) rows.push(generateTotalsRow(paypalTotals, PAYPAL_SALES_SUBTOTAL_HEADING));
  if (stripeConnectRows.length > 0) rows.push(generateTotalsRow(stripeTotals, STRIPE_CONNECT_SALES_SUBTOTAL_HEADING));
  return rows;
}

export function payoutCsv(data: readonly PayoutRow[], paypalRows: readonly PayoutRow[], stripeConnectRows: readonly PayoutRow[]): string {
  const rows: PayoutRow[] = [
    [...PAYOUT_HEADERS],
    ...data.map(annotatePayoutDeductionRow),
    ...subtotalRows(data, paypalRows, stripeConnectRows),
    generateTotalsRow(calculateTotals(data)),
  ];
  return csvSafeGenerate(rows);
}

// Sorts by date, keeping insertion order within a day (Ruby's sort_by.with_index).
export function sortPayoutRows(data: readonly PayoutRow[]): PayoutRow[] {
  return data
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const dateA = String(a.row[DATE_COLUMN]);
      const dateB = String(b.row[DATE_COLUMN]);
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export type Summary = { row: PayoutRow; deltaCents: number };

// The Ruby sums balances' amounts, minus the USD payout fee, and shows the gap as a Technical Adjustment row.
export function technicalAdjustmentRow(periodEndOn: string, expectedCents: number, runningTotalCents: number): PayoutRow | null {
  if (expectedCents === runningTotalCents) return null;
  const row = emptyRow();
  row[TYPE_COLUMN] = "Technical Adjustment";
  row[DATE_COLUMN] = periodEndOn;
  row[NET_TOTAL_COLUMN] = new RubyFloat((expectedCents - runningTotalCents) / CENTS_PER_DOLLAR);
  return row;
}

export function payoutFeeRow(periodEndOn: string, gumroadFeeCents: number): Summary {
  const row = emptyRow();
  row[TYPE_COLUMN] = "Payout Fee";
  row[DATE_COLUMN] = periodEndOn;
  row[GUMROAD_FEE_COLUMN] = rounded(gumroadFeeCents / CENTS_PER_DOLLAR);
  row[NET_TOTAL_COLUMN] = negated(rubyRoundHalfUp(gumroadFeeCents / CENTS_PER_DOLLAR, MONEY_DECIMALS));
  return { row, deltaCents: -gumroadFeeCents };
}

// Shared facts about a purchase; each field is the model method of the same name, in dollars unless noted.
export type SaleFacts = {
  externalId: string;
  linkName: string;
  fullName: string | null;
  buyerEmail: string | null;
  taxDollars: number;
  shippingDollars: number;
  priceDollars: number;
  feeDollars: number;
  netTotal: number;
  paymentCents: number;
  feeWaivedOnRefund: boolean;
};

function identity(sale: SaleFacts): CsvCell[] {
  return [sale.externalId, sale.linkName, sale.fullName, sale.buyerEmail];
}

export function saleSummary(sale: SaleFacts, succeededOn: string): Summary {
  return {
    row: ["Sale", succeededOn, ...identity(sale), new RubyFloat(sale.taxDollars), new RubyFloat(sale.shippingDollars),
      new RubyFloat(sale.priceDollars), new RubyFloat(sale.feeDollars), new RubyFloat(sale.netTotal)],
    deltaCents: sale.paymentCents,
  };
}

export function chargebackSummary(sale: SaleFacts, chargebackOn: string): Summary {
  return {
    row: ["Chargeback", chargebackOn, ...identity(sale), negated(sale.taxDollars), negated(sale.shippingDollars),
      negated(sale.priceDollars), negated(sale.feeDollars), negated(sale.netTotal)],
    deltaCents: -sale.paymentCents,
  };
}

export type RefundFacts = { createdOn: string; amountCents: number; feeCents: number; creatorTaxCents: number; retainedFeeCents: number | null };

// A refund whose balance transaction is gone or that is the whole purchase.
export function fullRefundSummary(refund: RefundFacts, sale: SaleFacts): Summary {
  const retainedDollars = rubyRoundHalfUp((refund.retainedFeeCents ?? 0) / CENTS_PER_DOLLAR, MONEY_DECIMALS);
  const fee = sale.feeWaivedOnRefund ? -sale.feeDollars : -sale.feeDollars + retainedDollars;
  const net = sale.feeWaivedOnRefund ? -sale.netTotal : -sale.netTotal - retainedDollars;
  return {
    row: ["Full Refund", refund.createdOn, ...identity(sale), negated(sale.taxDollars), negated(sale.shippingDollars),
      negated(sale.priceDollars), new RubyFloat(fee), new RubyFloat(net)],
    deltaCents: sale.feeWaivedOnRefund ? -sale.paymentCents : -sale.paymentCents - (refund.retainedFeeCents ?? 0),
  };
}

export type BalanceTransactionRefundFacts = {
  refund: RefundFacts;
  issuedAmountGrossCents: number;
  issuedAmountNetCents: number;
};

export function partialRefundSummary(btxn: BalanceTransactionRefundFacts, sale: SaleFacts): Summary {
  const grossDollars = -btxn.refund.amountCents / CENTS_PER_DOLLAR;
  let netDollars = btxn.issuedAmountNetCents / CENTS_PER_DOLLAR;
  let feeDollars = -btxn.refund.feeCents / CENTS_PER_DOLLAR;
  let deltaCents = btxn.issuedAmountNetCents;
  const retainedCents = btxn.refund.retainedFeeCents ?? 0;
  if (!sale.feeWaivedOnRefund) {
    feeDollars += retainedCents / CENTS_PER_DOLLAR;
    netDollars -= retainedCents / CENTS_PER_DOLLAR;
    deltaCents -= retainedCents;
  }
  return {
    row: ["Partial Refund", btxn.refund.createdOn, ...identity(sale), negated(rubyRoundHalfUp(btxn.refund.creatorTaxCents / CENTS_PER_DOLLAR)),
      new RubyFloat(-0), rounded(grossDollars), rounded(feeDollars), rounded(netDollars)],
    deltaCents,
  };
}

// A refund attempt that failed after acceptance: its debit is labelled "Failed Refund" and its offsetting
// credit "Failed Refund Reversal".
export function failedRefundSummary(btxn: { createdOn: string; issuedAmountGrossCents: number; issuedAmountNetCents: number }, sale: SaleFacts): Summary {
  return {
    row: [btxn.issuedAmountNetCents < 0 ? "Failed Refund" : "Failed Refund Reversal", btxn.createdOn, ...identity(sale), "", "",
      rounded(btxn.issuedAmountGrossCents / CENTS_PER_DOLLAR),
      rounded((btxn.issuedAmountGrossCents - btxn.issuedAmountNetCents) / CENTS_PER_DOLLAR),
      rounded(btxn.issuedAmountNetCents / CENTS_PER_DOLLAR)],
    deltaCents: btxn.issuedAmountNetCents,
  };
}

// PayPal and Stripe Connect refunds: these processors settle the money, so the row nets against the payout.
export function processorRefundSummary(label: "PayPal Refund" | "Stripe Connect Refund", refund: RefundFacts, sale: SaleFacts): Summary {
  return {
    row: [label, refund.createdOn, ...identity(sale), negated(rubyRoundHalfUp(refund.creatorTaxCents / CENTS_PER_DOLLAR)), new RubyFloat(-0),
      new RubyFloat(-rubyRoundHalfUp(refund.amountCents / CENTS_PER_DOLLAR)), rounded(refund.feeCents / CENTS_PER_DOLLAR),
      new RubyFloat(-rubyRoundHalfUp(refund.amountCents / CENTS_PER_DOLLAR) + rubyRoundHalfUp(refund.feeCents / CENTS_PER_DOLLAR))],
    deltaCents: -(refund.amountCents - refund.feeCents),
  };
}

export function affiliateCreditSummary(date: string, amountCents: number): Summary {
  const row = emptyRow();
  row[TYPE_COLUMN] = "Affiliate Credit";
  row[DATE_COLUMN] = date;
  row[PAYOUT_HEADERS.indexOf("Sale Price ($)")] = dollars(amountCents);
  row[NET_TOTAL_COLUMN] = dollars(amountCents);
  return { row, deltaCents: amountCents };
}

// Processor deduction rows (PayPal or Stripe Connect payouts and affiliate fees): the amount leaves the
// Gumroad payout.
export function processorDeductionSummary(label: string, date: string, amountCents: number): Summary {
  const row = emptyRow();
  row[TYPE_COLUMN] = label;
  row[DATE_COLUMN] = date;
  row[PAYOUT_HEADERS.indexOf("Sale Price ($)")] = negated(amountCents / CENTS_PER_DOLLAR);
  row[NET_TOTAL_COLUMN] = negated(amountCents / CENTS_PER_DOLLAR);
  return { row, deltaCents: -amountCents };
}
