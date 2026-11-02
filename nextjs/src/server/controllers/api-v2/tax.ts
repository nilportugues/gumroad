// Api::V2::EarningsController#show and Api::V2::TaxFormsController#index, both behind Api::V2::TaxCenterAccess
// (app/controllers/concerns/api/v2/tax_center_access.rb). #download fetches the PDF from Stripe or S3 and stays in Rails.
import { Prisma } from "@prisma/client";

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
);
