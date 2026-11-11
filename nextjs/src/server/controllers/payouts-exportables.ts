// Payouts::ExportablesController#index (`GET /payouts/exportables`): the years in which the seller has displayable completed
// payouts, and the payouts of the selected year, for the export dialog of the Payouts page. Sellers::BaseController's filters, then
// the action's `authorize :balance, :export?`.
import { Prisma } from "@prisma/client";

import { encrypt as externalId } from "../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { rubyToI } from "../page-props/customers/customers.ts";
import { formattedPayoutDate } from "../page-props/payouts/payout-schedule.ts";
import { balancePolicy } from "../policies/balance.ts";

import { type ActionContext, type ActionOptions, HandBackToRails, processAction } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { parseNestedQuery } from "./rails-body.ts";

export const PAYOUTS_EXPORTABLES_OPTIONS: ActionOptions = {};

// PayoutsHelper::OLDEST_DISPLAYABLE_PAYOUT_PERIOD_END_DATE, as `Payment.displayable` binds it.
const OLDEST_DISPLAYABLE = "2013-01-04";

// `current_seller.payments.completed.displayable`
const scopedPayments = (sellerId: bigint) =>
  Prisma.sql`${column("payments", "user_id")} = ${sellerId} AND ${column("payments", "state")} = 'completed' AND ${column("payments", "created_at")} >= ${OLDEST_DISPLAYABLE}`;

// config.time_zone is unset, so the database's UTC is also the zone `Time.zone.local(year).all_year` and the dates are read in.
async function yearsWithPayouts(sellerId: bigint): Promise<number[]> {
  const rows = await selectRows<{ year: bigint | number }>(
    Prisma.sql`SELECT DISTINCT EXTRACT(YEAR FROM ${column("payments", "created_at")}) AS year FROM ${table("payments")} WHERE ${scopedPayments(sellerId)} ORDER BY year DESC`,
  );
  const years = rows.map((row) => Number(row.year));
  return years.length > 0 ? years : [new Date().getUTCFullYear()];
}

// `params[:year]&.to_i`, then the first year unless it is one of the years with payouts.
export function selectedYearFor(years: number[], year: unknown): number {
  if (year !== undefined && year !== null && typeof year !== "string")
    throw new HandBackToRails("a year that is not a scalar");
  const requested = typeof year === "string" ? rubyToI(year) : null;
  return requested !== null && years.includes(requested) ? requested : years[0]!;
}

async function index(action: ActionContext) {
  return sellerJsonAction(action, balancePolicy.export, async (sellerContext) => {
    const sellerId = sellerContext.seller!.id;
    const years = await yearsWithPayouts(sellerId);
    const selectedYear = selectedYearFor(years, parseNestedQuery(action.request.queryString).year);
    const rows = await selectRows<{ id: bigint; created_at: Date }>(
      Prisma.sql`SELECT ${column("payments", "id")}, ${column("payments", "created_at")} FROM ${table("payments")} WHERE ${scopedPayments(sellerId)} AND ${column("payments", "created_at")} BETWEEN ${`${selectedYear}-01-01 00:00:00`} AND ${`${selectedYear}-12-31 23:59:59.999999`} ORDER BY ${column("payments", "created_at")} DESC`,
    );
    return jsonResponse(
      {
        years_with_payouts: years,
        selected_year: selectedYear,
        payouts_in_selected_year: rows.map((row) => ({
          id: externalId(row.id),
          date_formatted: formattedPayoutDate(row.created_at),
        })),
      },
      200,
    );
  });
}

export const payoutsExportablesResponse = (incoming: Request): Promise<Response> =>
  processAction(incoming, PAYOUTS_EXPORTABLES_OPTIONS, index);
