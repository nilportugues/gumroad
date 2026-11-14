// Port of app/services/exports/purchase_export_service.rb: the column list, the payment type labels, the zip
// padding and PurchaseExportService.compile (column placement, custom fields, the Totals row). Not ported:
// purchase_data (it reads ~40 Purchase methods and the preloaded associations) and pseudo_transliterate
// (ActiveSupport's transliterate table has no port yet). Those stay in the Ruby path until WS-45.
import { csvSafeGenerate, type CsvCell } from "../../lib/csv-safe.ts";
import { rubyRoundHalfUp } from "../../lib/ruby-round.ts";
import { rubyToF } from "../../lib/ruby-to-f.ts";
import { RubyFloat } from "../jobs/sidekiq/ruby-json.ts";

export const PURCHASE_FIELDS = [
  "Purchase ID",
  "Item Name",
  "Buyer Name",
  "Purchase Email",
  "Buyer Email",
  "Do not contact?",
  "Purchase Date",
  "Purchase Time (UTC timezone)",
  "Subtotal ($)",
  "Taxes ($)",
  "Tax Type",
  "Shipping ($)",
  "Sale Price ($)",
  "Fees ($)",
  "Net Total ($)",
  "Tip ($)",
  "Tax Included in Price?",
  "Street Address",
  "City",
  "Zip Code",
  "State",
  "Country",
  "Referrer",
  "Refunded?",
  "Partial Refund ($)",
  "Fully Refunded?",
  "Disputed?",
  "Dispute Won?",
  "Access Revoked?",
  "Variants",
  "Discount Code",
  "Recurring Charge?",
  "Free trial purchase?",
  "Pre-order authorization?",
  "Product ID",
  "Order Number",
  "Pre-order authorization time (UTC timezone)",
  "Custom Fields",
  "Item Price ($)",
  "Variants Price ($)",
  "Giftee Email",
  "SKU ID",
  "Quantity",
  "Recurrence",
  "Affiliate",
  "Affiliate commission ($)",
  "Discover?",
  "Cancellation Date",
  "Subscription End Date",
  "Rating",
  "Review",
  "License Key",
  "License Key Activation Count",
  "License Key Enabled?",
  "Payment Type",
  "PayPal Transaction ID",
  "PayPal Fee Amount",
  "PayPal Fee Currency",
  "Stripe Transaction ID",
  "Stripe Fee Amount",
  "Stripe Fee Currency",
  "Purchasing Power Parity Discounted?",
  "Upsold?",
  "Sent Abandoned Cart Email?",
  "UTM Source",
  "UTM Medium",
  "UTM Campaign",
  "UTM Term",
  "UTM Content",
  "Buyer Currency",
  "Buyer Total",
  "Buyer Refunded Total",
] as const;

export const TOTALS_COLUMN_NAME = "Totals";
export const TOTALS_FIELDS: readonly string[] = [
  "Subtotal ($)",
  "Taxes ($)",
  "Shipping ($)",
  "Sale Price ($)",
  "Fees ($)",
  "Net Total ($)",
  "Tip ($)",
  "Partial Refund ($)",
  "Variants Price ($)",
  "Item Price ($)",
  "Affiliate commission ($)",
  "PayPal Fee Amount",
  "Stripe Fee Amount",
];
export const SYNCHRONOUS_EXPORT_THRESHOLD = 2_000;
const ZIP_CODE_WIDTH = 5;

// Stored card_type values that are not cards. Anything else is charged as a card and labelled "Card".
export const PAYMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  paypal: "PayPal",
  upi: "UPI",
  ideal: "iDEAL",
  bancontact: "Bancontact",
  pix: "Pix",
  klarna: "Klarna",
  alipay: "Alipay",
};
const CARD_PAYMENT_LABEL = "Card";

export function paymentTypeLabel(cardType: string | null | undefined): string | undefined {
  if (cardType === null || cardType === undefined || cardType.trim() === "") return undefined;
  return Object.hasOwn(PAYMENT_TYPE_LABELS, cardType) ? PAYMENT_TYPE_LABELS[cardType] : CARD_PAYMENT_LABEL;
}

// zip_code.to_s.rjust(5, "0"); a missing zip stays missing.
export function zipCodeForExport(zipCode: string | null | undefined): string | null | undefined {
  if (zipCode === null || zipCode === undefined) return zipCode;
  return zipCode.padStart(ZIP_CODE_WIDTH, "0");
}

export type PurchaseDataRow = {
  // Keyed by PURCHASE_FIELDS names.
  fields: Readonly<Record<string, CsvCell>>;
  // Keyed by custom field name; written over the column the name is found at.
  customFields: Readonly<Record<string, CsvCell>>;
};

// PurchaseExportService.compile: the purchase rows, with custom field values placed by their last matching
// column (Ruby's rindex) and a Totals row of each TOTALS_FIELDS column rounded to cents.
export function purchaseExportCsv(customFields: readonly string[], rows: readonly PurchaseDataRow[]): string {
  const fields: string[] = [...PURCHASE_FIELDS, ...customFields];
  const totals = new Map<string, number>();
  const body = rows.map((row) => {
    const cells: CsvCell[] = fields.map(() => null);
    for (const [column, value] of Object.entries(row.fields)) {
      cells[fields.indexOf(column)] = value;
      if (TOTALS_FIELDS.includes(column)) totals.set(column, (totals.get(column) ?? 0) + rubyToF(value));
    }
    for (const [column, value] of Object.entries(row.customFields)) {
      cells[fields.lastIndexOf(column)] = value;
    }
    return cells;
  });

  const totalsRow: CsvCell[] = fields.map(() => null);
  totalsRow[0] = TOTALS_COLUMN_NAME;
  for (const [column, value] of totals) {
    totalsRow[fields.indexOf(column)] = new RubyFloat(rubyRoundHalfUp(value, 2));
  }
  return csvSafeGenerate([fields, ...body, totalsRow]);
}
