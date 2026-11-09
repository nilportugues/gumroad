// The tax lines of a receipt's payment info (ReceiptPresenter::PaymentInfo#today_tax_price_attributes) and the label
// Purchase#tax_label gives them. Reads follow Rails: the purchase's TaxJar row (Canadian splits), then its ZipTaxRate,
// then the refunds that came out of Gumroad-collected tax.
import { Prisma } from "@prisma/client";

import { isBlank } from "../../html/text-helper.ts";
import { PurchaseFlags } from "../../search/flags.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { MailViewNotPortedError } from "../views.ts";

type Id = number | bigint;

// Compliance::Countries
export const EU_VAT_APPLICABLE_COUNTRY_CODES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB"]);
export const NORWAY_VAT_APPLICABLE_COUNTRY_CODES = new Set(["NO"]);
export const GST_APPLICABLE_COUNTRY_CODES = new Set(["AU", "SG"]);
export const COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS = new Set(["IS", "JP", "NZ", "ZA", "CH", "AE", "IN"]);
export const COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS = new Set([
  "BY", "CL", "CO", "CR", "EC", "EG", "GE", "KZ", "MY", "MD", "MA", "RU", "SA", "RS", "KR", "TH", "TR", "UA", "UZ", "VN",
  "BH", "KE", "NG", "OM", "TZ",
]);
const TAX_NAME_BY_COUNTRY_CODE: Record<string, string> = { IN: "GST", NZ: "GST", AU: "GST", SG: "GST", MY: "Service tax", JP: "CT" };

export const taxNameFor = (country: string) => (Object.hasOwn(TAX_NAME_BY_COUNTRY_CODE, country) ? TAX_NAME_BY_COUNTRY_CODE[country]! : "VAT");

export type TaxPurchase = {
  id: Id;
  flags: Id | null;
  tax_cents: number | null;
  gumroad_tax_cents: number | null;
  total_transaction_cents: number | null;
  zip_tax_rate_id: Id | null;
};

export type TaxLine = { label: string; cents: number };

const star = (tableName: string) => Prisma.raw(`\`${tableName}\`.*`);

// The tax line, or null when the purchase is not taxable. `amount_cents` is Purchase#non_refunded_tax_amount.
export async function taxLines(purchase: TaxPurchase, presentment: { sellerTaxCents: number; gumroadTaxCents: number } | null = null): Promise<TaxLine[] | null> {
  if (!PurchaseFlags.isSet(purchase.flags ?? 0, "was_purchase_taxable")) return null;
  // non_refunded_tax_amount reads a NULL gumroad_tax_cents as zero
  const gumroadTaxCents = purchase.gumroad_tax_cents ?? 0;

  let amountCents = 0;
  if ((purchase.total_transaction_cents ?? 0) !== 0) {
    if (presentment) {
      // buyer_presentment_non_refunded_tax_cents: the refunds are known to be none (the receipt would have gone to Rails)
      amountCents = Math.max(presentment.sellerTaxCents + presentment.gumroadTaxCents, 0);
    } else if (gumroadTaxCents > 0) {
      // refunds.effective.sum(:gumroad_tax_cents)
      const [sum] = await selectRows<Record<string, Prisma.Decimal | number | bigint | string | null>>(
        Prisma.sql`SELECT SUM(${column("refunds", "gumroad_tax_cents")}) FROM ${table("refunds")} WHERE ${column("refunds", "purchase_id")} = ${purchase.id} AND (refunds.status IS NULL OR refunds.status NOT IN ('failed', 'canceled') OR COALESCE(refunds.json_data->>'$.balance_reversed_on_failure', 'false') != 'true')`,
      );
      amountCents = gumroadTaxCents - Number(sum ? (Object.values(sum)[0] ?? 0) : 0);
    } else {
      if (purchase.tax_cents === null) throw new MailViewNotPortedError("taxed receipt without a tax amount");
      amountCents = purchase.tax_cents;
    }
  }

  // calculate_tax_amount_cents reads the purchase's TaxJar row: Canadian taxes are split into their own lines.
  const [taxjar] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT ${star("purchase_taxjar_infos")} FROM ${table("purchase_taxjar_infos")} WHERE ${column("purchase_taxjar_infos", "purchase_id")} = ${purchase.id} LIMIT 1`);
  if (taxjar && ["gst_tax_rate", "pst_tax_rate", "qst_tax_rate"].some((field) => taxjar[field] !== null && Number(taxjar[field]) !== 0)) {
    throw new MailViewNotPortedError("taxed receipt with Canadian tax splits");
  }
  return [{ label: await taxLabel(purchase), cents: amountCents }];
}

// Purchase#tax_label_with_creator_tax_info
async function taxLabel(purchase: TaxPurchase): Promise<string> {
  const zipTaxRate =
    purchase.zip_tax_rate_id === null
      ? null
      : (await selectRows<Record<string, unknown>>(Prisma.sql`SELECT ${star("zip_tax_rates")} FROM ${table("zip_tax_rates")} WHERE ${column("zip_tax_rates", "id")} = ${purchase.zip_tax_rate_id} LIMIT 1`))[0] ?? null;
  // A creator's own tax rate carries their tax ID in its JSON data.
  if (zipTaxRate && zipTaxRate.user_id !== null) throw new MailViewNotPortedError("taxed receipt with a creator tax rate");
  const country = zipTaxRate === null || isBlank(zipTaxRate.country as string | null) ? null : String(zipTaxRate.country);
  if (country !== null && (EU_VAT_APPLICABLE_COUNTRY_CODES.has(country) || NORWAY_VAT_APPLICABLE_COUNTRY_CODES.has(country) || COUNTRIES_THAT_COLLECT_TAX_ON_ALL_PRODUCTS.has(country) || COUNTRIES_THAT_COLLECT_TAX_ON_DIGITAL_PRODUCTS.has(country) || GST_APPLICABLE_COUNTRY_CODES.has(country))) {
    if (zipTaxRate!.combined_rate === null) throw new MailViewNotPortedError("taxed receipt without a combined tax rate");
    // (combined_rate * 100).to_i
    return `${taxNameFor(country)} (${new Prisma.Decimal(zipTaxRate!.combined_rate as never).mul(100).trunc().toString()}%)`;
  }
  return PurchaseFlags.isSet(purchase.flags ?? 0, "was_tax_excluded_from_price") ? "Sales tax" : "Sales tax (included)";
}
