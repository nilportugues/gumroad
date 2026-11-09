// Port of app/services/exports/tax_summary/{transaction_report,payable,annual}.rb: the 1099-K transaction
// report (rows, totals, Stripe window and platform-charge lookup), the Payable row and the annual filename.
// Not ported: the Stripe list calls and the DB reads (they are the job path, WS-30 and WS-45), and
// Payable's decrypted tax IDs, which the caller passes in.
import { csvSafeGenerate, type CsvCell } from "../../lib/csv-safe.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export const TRANSACTION_REPORT_HEADERS = [
  "Charge date (UTC)",
  "Funds available date (UTC)",
  "Stripe payment ID",
  "Gumroad sale ID",
  "Product price ($)",
  "Sales tax collected ($)",
  "Amount ($)",
] as const;

// Each type needs its own list call: the endpoint takes one type filter.
export const BALANCE_TRANSACTION_TYPES = ["charge", "payment"] as const;
const CENTS_PER_DOLLAR = 100;
const MONEY_DECIMALS = 2;
const SALE_ID_SEPARATOR = "; ";
const TOTAL_LABEL = "Total";

// Time.utc(year).to_i and Time.utc(year + 1).to_i.
export function balanceTransactionWindow(year: number): { gte: number; lt: number } {
  return { gte: Date.UTC(year, 0, 1) / 1000, lt: Date.UTC(year + 1, 0, 1) / 1000 };
}

type StripeSourceCharge = { id: string; source_transfer?: { source_transaction?: string | null } | null };

// The platform-side charge ID the purchase stored. A direct charge is its own source; a transferred payment
// is the platform charge that funded the transfer, falling back to the source's own ID.
export function platformChargeId(source: string | StripeSourceCharge): string {
  if (typeof source === "string") return source;
  return source.source_transfer?.source_transaction ?? source.id;
}

export type BalanceTransactionFacts = {
  created: number;
  availableOn: number;
  chargeId: string;
  amountCents: number;
};

export type MatchedSale = {
  externalId: string;
  priceCents: number;
  gumroadTaxCents: number | null;
};

// Ruby's format("%.2f", cents / 100.0).
export function formatCents(cents: number): string {
  return (cents / CENTS_PER_DOLLAR).toFixed(MONEY_DECIMALS);
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// Rows are sorted by the funds-available date. Ruby's sort_by is unstable, so ties can come out in another
// order here; the Totals row does not depend on it.
export function transactionReportCsv(
  transactions: readonly BalanceTransactionFacts[],
  salesByChargeId: ReadonlyMap<string, readonly MatchedSale[]>,
): string {
  const sorted = [...transactions].sort((a, b) => a.availableOn - b.availableOn);
  let totalCents = 0;
  const rows: CsvCell[][] = sorted.map((transaction) => {
    const matched = salesByChargeId.get(transaction.chargeId) ?? [];
    totalCents += transaction.amountCents;
    const hasSales = matched.length > 0;
    return [
      utcDate(transaction.created),
      utcDate(transaction.availableOn),
      transaction.chargeId,
      hasSales ? matched.map((sale) => sale.externalId).join(SALE_ID_SEPARATOR) : null,
      hasSales ? formatCents(matched.reduce((sum, sale) => sum + sale.priceCents, 0)) : null,
      hasSales ? formatCents(matched.reduce((sum, sale) => sum + (sale.gumroadTaxCents ?? 0), 0)) : null,
      formatCents(transaction.amountCents),
    ];
  });
  const totalRow: CsvCell[] = [TOTAL_LABEL, null, null, null, null, null, formatCents(totalCents)];
  return csvSafeGenerate([[...TRANSACTION_REPORT_HEADERS], ...rows, totalRow]);
}

// Payable's 1099-K import headers. The row built by payableRow lines up with these.
export const PAYABLE_HEADERS = [
  "Payable Worker ID",
  "External Worker ID",
  "Stripe ID",
  "Display Name", "First Name", "Last Name", "Business Name",
  "Email",
  "Address Line 1", "Address Line 2", "City", "Region", "Postal Code", "Country",
  "Business Type",
  "SSN", "EIN",
  "Filer Is",
  "Transactions Reported Are",
  "PSE's Name", "PSE's Phone",
  "Box 1a - Gross Amount of Transactions", "Box 1b - Card Not Present Transactions",
  "Box 2 - Merchant Category Code",
  "Box 3 - Number of Payment Transactions",
  "Box 4 - Federal Income Tax Withheld",
  "Box 5a - Jan", "Box 5b - Feb", "Box 5c - Mar", "Box 5d - Apr", "Box 5e - May", "Box 5f - Jun",
  "Box 5g - Jul", "Box 5h - Aug", "Box 5i - Sep", "Box 5j - Oct", "Box 5k - Nov", "Box 5l - Dec",
  "Box 6 - State Abbreviation", "Box 6 (Other State) - Other State Abbreviation",
  "Box 7 - Filer's State ID", "Box 7 (Other State) - Filer's Other State ID",
  "Box 8 - State Tax Withheld", "Box 8 (Other State) - Other State Tax Withheld",
] as const;

const PAYABLE_MONTHS = 12;
const PAYABLE_FILER_IS = "EPF Other";
const PAYABLE_REPORTED_AS = "Third Party Network";
const PAYABLE_PSE_NAME = "Gumroad";
const PAYABLE_PSE_PHONE = "(650) 204-3486";

export type PayableSummary = {
  // Cents per month, index 0 is January.
  transactionCentsByMonth: readonly number[];
  totalTransactionCents: number;
  transactionsCount: number;
};

// Exports::TaxSummary::Payable#perform returns nothing unless the seller's compliance info is complete and
// there is taxable volume in the year.
export function payableIsReportable(hasCompletedCompliance: boolean, summary: PayableSummary): boolean {
  return hasCompletedCompliance && summary.totalTransactionCents > 0;
}

export type PayableRowInput = {
  externalId: string;
  stripeId: string | null;
  firstAndLastName: string | null;
  firstName: string | null;
  lastName: string | null;
  legalEntityName: string | null;
  email: string;
  legalEntityStreetAddress: string | null;
  legalEntityCity: string | null;
  legalEntityStateCode: string | null;
  legalEntityZipCode: string | null;
  legalEntityCountryCode: string | null;
  legalEntityPayableBusinessType: string | null;
  personalTaxId: string | null;
  businessTaxId: string | null;
  summary: PayableSummary;
};

export function payableRow(input: PayableRowInput): CsvCell[] {
  const row: CsvCell[] = [
    null,
    input.externalId,
    input.stripeId,
    input.firstAndLastName,
    input.firstName,
    input.lastName,
    input.legalEntityName,
    input.email,
    input.legalEntityStreetAddress,
    null,
    input.legalEntityCity,
    input.legalEntityStateCode,
    input.legalEntityZipCode,
    input.legalEntityCountryCode,
    input.legalEntityPayableBusinessType,
    presence(input.personalTaxId),
    presence(input.businessTaxId),
    PAYABLE_FILER_IS,
    PAYABLE_REPORTED_AS,
    PAYABLE_PSE_NAME,
    PAYABLE_PSE_PHONE,
    new RubyFloat(input.summary.totalTransactionCents / CENTS_PER_DOLLAR),
    null,
    null,
    input.summary.transactionsCount,
    null,
  ];
  for (let month = 0; month < PAYABLE_MONTHS; month += 1) {
    const cents = input.summary.transactionCentsByMonth[month] ?? 0;
    row.push(new RubyFloat(cents / CENTS_PER_DOLLAR));
  }
  row.push(input.legalEntityStateCode, null, null, null, null, null);
  return row;
}

function presence(value: string | null): string | null {
  return value !== null && value.trim() !== "" ? value : null;
}

// Exports::TaxSummary::Annual#tempfile_name. `week` is strftime("%W"): weeks start on Monday, week 00 is the
// days before the year's first Monday.
export function annualTaxSummaryFilename(year: number, uuid: string, now: Date): string {
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - startOfYear) / 86_400_000);
  const weekday = now.getUTCDay();
  const week = Math.floor((dayOfYear + 7 - (weekday === 0 ? 6 : weekday - 1)) / 7);
  return `annual_exports_${year}_${uuid}-${String(week).padStart(2, "0")}.csv`;
}
