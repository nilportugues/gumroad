// TaxCenterController#index: TaxCenterPresenter#props and User#tax_center_enabled?.
import { Prisma, type User } from "@prisma/client";

import { RubySymbol, type MarshalValue } from "../../cache/marshal.ts";
import { railsCache } from "../../cache/rails-cache.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";
import { countryAlpha2 } from "../signed-in/data.ts";
import { aliveComplianceInfo } from "../signed-in/reads.ts";

// User#tax_center_enabled? (from_us?): `alive_user_compliance_info&.country_code == "US"`
export async function taxCenterEnabled(userId: bigint): Promise<boolean> {
  const info = await aliveComplianceInfo(userId);
  return info !== null && countryAlpha2(info.country) === "US";
}

// User#tax_form_available_years, reversed
const availableYears = (seller: User, now: Date) => {
  const years: number[] = [];
  for (let year = now.getUTCFullYear() - 1; year >= seller.created_at!.getUTCFullYear(); year--) years.push(year);
  return years;
};

const sym = (name: string) => new RubySymbol(name);

// String#to_i
export function rubyToI(value: string): number {
  const match = /^\s*[-+]?\d[\d_]*/.exec(value);
  return match ? Number(match[0].replaceAll("_", "")) : 0;
}

// Money.new(cents, "usd").format(symbol: true)
export function formatCentsAsDollars(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const dollars = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${dollars}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

// `seller.sales.successful.not_fully_refunded.not_chargedback_or_chargedback_reversed` for the year.
// Rails binds the Date bounds as dates, so a sale after midnight on Dec 31 is left out.
export async function totals(sellerId: bigint, year: number) {
  const p = (name: string) => column("purchases", name);
  const [row] = await selectRows<Record<"gross" | "fees" | "taxes" | "affiliate_credit", bigint>>(
    Prisma.sql`SELECT CAST(COALESCE(SUM(${p("total_transaction_cents")}), 0) AS SIGNED) AS gross, CAST(COALESCE(SUM(${p("fee_cents")}), 0) AS SIGNED) AS fees, CAST(COALESCE(SUM(COALESCE(${p("gumroad_tax_cents")}, 0) + COALESCE(${p("tax_cents")}, 0)), 0) AS SIGNED) AS taxes, CAST(COALESCE(SUM(${p("affiliate_credit_cents")}), 0) AS SIGNED) AS affiliate_credit FROM ${table("purchases")} WHERE ${p("seller_id")} = ${sellerId} AND ${p("purchase_state")} = 'successful' AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) AND ${p("created_at")} BETWEEN ${`${year}-01-01`} AND ${`${year}-12-31`} AND (purchases.price_cents > 0)`,
  );
  return { gross: BigInt(row!.gross), fees: BigInt(row!.fees), taxes: BigInt(row!.taxes), affiliateCredit: BigInt(row!.affiliate_credit) };
}

type TaxFormRow = { tax_form_type: string; json_data: string | null };

async function taxFormFor(sellerId: bigint, year: number): Promise<TaxFormRow | null> {
  const [row] = await selectRows<TaxFormRow>(
    Prisma.sql`SELECT ${column("user_tax_forms", "tax_form_type")}, ${column("user_tax_forms", "json_data")} FROM ${table("user_tax_forms")} WHERE ${column("user_tax_forms", "user_id")} = ${sellerId} AND ${column("user_tax_forms", "tax_year")} = ${year} ORDER BY ${column("user_tax_forms", "id")} ASC LIMIT 1`,
  );
  return row ?? null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Time.at(filed_at).strftime("%B %-d, %Y"), in the server's zone (UTC).
function filedAtText(value: unknown): string {
  if (typeof value !== "number") throw new NotPortedError("UserTaxForm#filed_at that is not an epoch number");
  const date = new Date(value * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

// `tax_form.stripe_account_id || seller.stripe_account&.charge_processor_merchant_id` (an empty string
// is truthy in Ruby), and whether that account is still one of the seller's live Stripe accounts.
async function transactionReportAvailable(sellerId: bigint, form: TaxFormRow, formAccountId: string | null): Promise<boolean> {
  if (form.tax_form_type !== "us_1099_k") return false;
  const m = (name: string) => column("merchant_accounts", name);
  const alive = await selectRows<{ charge_processor_merchant_id: string | null; connect: number | boolean }>(
    Prisma.sql`SELECT ${m("charge_processor_merchant_id")}, (JSON_UNQUOTE(JSON_EXTRACT(${m("json_data")}, '$.meta.stripe_connect')) = 'true') AS connect FROM ${table("merchant_accounts")} WHERE ${m("user_id")} = ${sellerId} AND ${m("deleted_at")} IS NULL AND ${m("charge_processor_alive_at")} IS NOT NULL AND ${m("charge_processor_deleted_at")} IS NULL AND ${m("charge_processor_id")} = 'stripe' ORDER BY ${m("id")} ASC`,
  );
  const accountId = formAccountId ?? alive.find((account) => Number(account.connect) !== 1)?.charge_processor_merchant_id ?? null;
  return accountId !== null && accountId !== "" && alive.some((account) => account.charge_processor_merchant_id === accountId);
}

export async function taxCenterProps(seller: User, requestedYear: number, now = new Date()): Promise<Record<string, unknown>> {
  const years = availableYears(seller, now);
  const year = years.includes(requestedYear) ? requestedYear : (years[0] ?? null);
  const documents: Record<string, unknown>[] = [];

  const form = year === null ? null : await taxFormFor(seller.id, year);
  if (form && year !== null) {
    const data = form.json_data ? (JSON.parse(form.json_data) as Record<string, unknown>) : {};
    const type = form.tax_form_type;
    const cached = await railsCache().fetch(`tax_form_data_${type}_${year}_${seller.id}`, {}, async () => {
      const t = await totals(seller.id, year);
      const net = t.gross - t.fees - t.taxes - t.affiliateCredit;
      return new Map<MarshalValue, MarshalValue>([
        [sym("document"), type.replace(/^us_/, "").replaceAll("_", "-").toUpperCase()],
        [sym("type"), "IRS form"],
        [sym("year"), year],
        [sym("form_type"), type],
        [sym("gross"), formatCentsAsDollars(t.gross)],
        [sym("fees"), formatCentsAsDollars(t.fees)],
        [sym("taxes"), formatCentsAsDollars(t.taxes)],
        [sym("affiliate_credit"), formatCentsAsDollars(t.affiliateCredit)],
        [sym("net"), formatCentsAsDollars(net)],
      ]);
    });
    const document: Record<string, unknown> = {};
    for (const [key, value] of cached instanceof Map ? cached : []) document[(key as RubySymbol).name] = value;
    const filed = data.filed_at;
    const filedPresent = filed !== null && filed !== undefined && filed !== "";
    documents.push({
      ...document,
      filed_at: filedPresent ? filedAtText(filed) : null,
      transaction_report_available: await transactionReportAvailable(seller.id, form, typeof data.stripe_account_id === "string" ? data.stripe_account_id : null),
    });
  }
  return { documents, available_years: years, selected_year: year };
}
