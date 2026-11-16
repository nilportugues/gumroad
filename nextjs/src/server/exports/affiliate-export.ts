// Port of app/services/exports/affiliate_export_service.rb (the CSV and the sync/async decision; the job body
// is Exports::AffiliateExportWorker, WS-30). The enqueue lives in enqueue.ts.
import { csvSafeGenerate, type CsvCell } from "../../lib/csv-safe.ts";
import { moneyFormatterFormat } from "../models/concerns/money-formatter.ts";

export const AFFILIATE_FIELDS = [
  "Affiliate ID",
  "Name",
  "Email",
  "Fee",
  "Products",
  "Sales ($)",
  "Referral URL",
  "Destination URL",
  "Created At",
] as const;

export const TOTALS_COLUMN_NAME = "Totals";
export const SYNCHRONOUS_EXPORT_THRESHOLD = 500;

const SALES_COLUMN = "Sales ($)";

export type AffiliateRow = {
  externalIdNumeric: number | bigint;
  name: string | null;
  username: string;
  email: string;
  // Whole percent, as affiliate_percentage is stored.
  affiliatePercentage: number;
  salesCents: number;
  productNames: readonly string[];
  referralUrl: string | null;
  destinationUrl: string | null;
  // The affiliate's created_at as a calendar date in their own time zone, YYYY-MM-DD.
  createdOn: string;
};

export function affiliateExportFilename(username: string, now: Date): string {
  const timestamp = now.toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "-");
  return `Affiliates-${username}_${timestamp}.csv`;
}

// Array#to_s of strings, which is Array#inspect: `["Product 1", "B"]`.
export function rubyInspectStrings(values: readonly string[]): string {
  return `[${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(", ")}]`;
}

// `name.presence || username`: a blank name falls back to the username.
function displayName(row: AffiliateRow): string {
  return row.name !== null && row.name.trim() !== "" ? row.name : row.username;
}

export function affiliateRow(row: AffiliateRow): CsvCell[] {
  return [
    row.externalIdNumeric,
    displayName(row),
    row.email,
    `${row.affiliatePercentage} %`,
    rubyInspectStrings(row.productNames),
    moneyFormatterFormat(row.salesCents, "usd", { symbol: false }),
    row.referralUrl,
    row.destinationUrl,
    row.createdOn,
  ];
}

// The sales column is summed in cents, not from the rendered cell: "1,234.56" would parse as 1.0.
// Rails fills a totals cell only for a column some affiliate added to, so an export without affiliates leaves it blank.
export function affiliateTotalsRow(totalsCents: number, hasAffiliates = true): CsvCell[] {
  const row: CsvCell[] = AFFILIATE_FIELDS.map(() => null);
  row[0] = TOTALS_COLUMN_NAME;
  if (hasAffiliates)
    row[AFFILIATE_FIELDS.indexOf(SALES_COLUMN)] = moneyFormatterFormat(totalsCents, "usd", { symbol: false });
  return row;
}

export function affiliateExportCsv(affiliates: readonly AffiliateRow[]): string {
  const rows = affiliates.map(affiliateRow);
  const totalCents = affiliates.reduce((sum, affiliate) => sum + affiliate.salesCents, 0);
  return csvSafeGenerate([[...AFFILIATE_FIELDS], ...rows, affiliateTotalsRow(totalCents, affiliates.length > 0)]);
}

// Exports::AffiliateExportService.export: true when the seller's live affiliate count is small enough to
// build inline, false when the export is handed to the job.
export function runsSynchronously(
  liveAffiliateCount: number,
  threshold: number = SYNCHRONOUS_EXPORT_THRESHOLD,
): boolean {
  return liveAffiliateCount <= threshold;
}
