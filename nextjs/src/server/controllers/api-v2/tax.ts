// Api::V2::EarningsController#show and Api::V2::TaxFormsController#index, both behind Api::V2::TaxCenterAccess
// (app/controllers/concerns/api/v2/tax_center_access.rb), and the 404s of TaxFormsController#download. The PDF itself comes from Stripe or S3,
// so a download that passes those checks goes to Rails.
import { Prisma } from "@prisma/client";

import { STRIPE_CHARGE_PROCESSOR_ID, stripeAccountOf } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { taxCenterEnabled, totals } from "../../page-props/dashboard/tax-center.ts";
import { HandBackToRails, type Rendered } from "../application-controller.ts";
import { type ApiV2Input, json, registerApiV2, renderResponse } from "./base.ts";

// Integer(string, exception: false) for plain decimals. Prefixed forms (0x, 0b, 0o, a leading 0) are Ruby's to parse.
function parseYear(value: unknown): number | null {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : "{}";
  if (/^\s*[-+]?0[xXbBoO0-9_]/u.test(text) && !/^\s*[-+]?0\s*$/u.test(text)) throw new HandBackToRails("a year Ruby's Integer() reads with a radix prefix");
  const match = /^\s*([-+]?)(0|[1-9]\d*(?:_\d+)*)\s*$/u.exec(text);
  return match === null ? null : Number(`${match[1]}${match[2]!.replaceAll("_", "")}`);
}

// before_action :ensure_tax_center_enabled
async function ensureTaxCenterEnabled({ owner }: ApiV2Input): Promise<Rendered | undefined> {
  if (await taxCenterEnabled(owner.id)) return undefined;
  return json({ success: false, message: "Tax center is not enabled for this account." }, 403);
}

// User#tax_form_available_years: created_at.year..(Time.current.year - 1)
const availableYears = (createdAt: Date, now = new Date()) => Array.from({ length: Math.max(now.getUTCFullYear() - createdAt.getUTCFullYear(), 0) }, (_, index) => createdAt.getUTCFullYear() + index);

const yearNotAvailable = (year: number | null, label: string) => json({ success: false, message: `${label} are not available ${year === null ? "for the requested year." : `for ${year}.`}` }, 404);

// UserTaxForm::TAX_FORM_TYPES
const TAX_FORM_TYPES = ["us_1099_k", "us_1099_misc"];

const formNotFound = () => json({ success: false, message: "Tax form not found." }, 404);

// UserTaxForm#stripe_account_id: a JsonData accessor. Anything but a string (or null) is Ruby's to interpret.
function formStripeAccountId(jsonData: string | null): string | null {
  if (jsonData === null || jsonData.trim() === "") return null;
  const data: unknown = JSON.parse(jsonData);
  if (data === null) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new HandBackToRails("tax form json_data that is not a hash");
  const id = (data as Record<string, unknown>).stripe_account_id;
  if (id === undefined || id === null) return null;
  if (typeof id !== "string") throw new HandBackToRails("a stripe_account_id that is not a string");
  return id;
}

async function download({ owner, params }: ApiV2Input) {
  const year = parseYear(params.year);
  const type = params.tax_form_type;
  if (year === null || !availableYears(owner.created_at!).includes(year)) return formNotFound();
  if (typeof type !== "string" || !TAX_FORM_TYPES.includes(type)) return formNotFound();

  const [form] = await selectRows<{ json_data: string | null }>(
    Prisma.sql`SELECT json_data FROM ${table("user_tax_forms")} WHERE ${column("user_tax_forms", "user_id")} = ${owner.id} AND ${column("user_tax_forms", "tax_year")} = ${year} AND ${column("user_tax_forms", "tax_form_type")} = ${type} LIMIT 1`,
  );
  if (form === undefined) return formNotFound();

  // An empty id is truthy in Ruby, so it is looked up like any other.
  const stripeAccountId = formStripeAccountId(form.json_data) ?? (await stripeAccountOf(owner.id))?.charge_processor_merchant_id ?? null;
  if (stripeAccountId !== null) {
    const owned = await selectRows(
      Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${owner.id} AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${stripeAccountId} LIMIT 1`,
    );
    if (owned.length === 0) return formNotFound();
  }
  throw new HandBackToRails("a tax form PDF fetched from Stripe or S3");
}

registerApiV2(
  {
    method: "GET",
    pattern: "/v2/earnings",
    scopes: ["view_tax_data"],
    before: ensureTaxCenterEnabled,
    async run({ owner, params }) {
      const year = parseYear(params.year);
      if (year === null || !availableYears(owner.created_at!).includes(year)) return yearNotAvailable(year, "Earnings");

      const sums = await totals(owner.id, year);
      const net = sums.gross - sums.fees - sums.taxes - sums.affiliateCredit;
      return json({
        success: true,
        year,
        currency: "usd",
        gross_cents: Number(sums.gross),
        fees_cents: Number(sums.fees),
        taxes_cents: Number(sums.taxes),
        affiliate_credit_cents: Number(sums.affiliateCredit),
        net_cents: Number(net),
      });
    },
  },
  {
    method: "GET",
    pattern: "/v2/tax_forms",
    scopes: ["view_tax_data"],
    before: ensureTaxCenterEnabled,
    async run({ owner, params }) {
      const conditions = [Prisma.sql`${column("user_tax_forms", "user_id")} = ${owner.id}`];
      const requested = params.year;
      if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
        const year = parseYear(requested);
        if (year === null || !availableYears(owner.created_at!).includes(year)) return yearNotAvailable(year, "Tax forms");
        conditions.push(Prisma.sql`${column("user_tax_forms", "tax_year")} = ${year}`);
      }
      const forms = await selectRows<{ tax_year: number; tax_form_type: string; json_data: string | null }>(
        Prisma.sql`SELECT tax_year, tax_form_type, json_data FROM ${table("user_tax_forms")} WHERE ${Prisma.join(conditions, " AND ")} ORDER BY tax_year ASC, tax_form_type ASC`,
      );
      return renderResponse(true, {
        tax_forms: forms.map((form) => {
          const filed = form.json_data ? (JSON.parse(form.json_data) as Record<string, unknown>).filed_at : null;
          if (filed !== null && filed !== undefined && filed !== "" && typeof filed !== "number") throw new HandBackToRails("a filed_at that is not an epoch number");
          return { tax_year: form.tax_year, tax_form_type: form.tax_form_type, filed_at: typeof filed === "number" ? `${new Date(filed * 1000).toISOString().slice(0, 19)}Z` : null };
        }),
      });
    },
  },
  { method: "GET", pattern: "/v2/tax_forms/:year/:tax_form_type/download", scopes: ["view_tax_data"], before: ensureTaxCenterEnabled, run: download },
);
