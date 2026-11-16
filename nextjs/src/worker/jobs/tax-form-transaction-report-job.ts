// Port of app/sidekiq/tax_form_transaction_report_job.rb up to the report. `User.find`, the seller's 1099-K tax form of the year and the
// check that its Stripe account is one of the seller's live merchant accounts run in Node; building the report pages through Stripe
// and mails it, so a job that gets that far hands back before the first Stripe call. A tax form without a Stripe account id of its own
// falls back to the seller's own Stripe account (`User#stripe_account`), which hands back after the tax form read.
// Golden: __fixtures__/tax-form-transaction-report-job.golden.json (scripts/golden/tax-form-transaction-report-job.rb).
import { Prisma } from "@prisma/client";

import { notifyError } from "../../server/infra/error-reporting.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";
import type { RetriesExhausted } from "../retry.ts";

import { modelJob } from "./support/job-deps.ts";

const TAX_FORMS = "user_tax_forms";
const MERCHANT_ACCOUNTS = "merchant_accounts";
const US_1099_K = "us_1099_k";
const STRIPE = "stripe";
// `tax_year` is a 4-byte integer column; a longer string raises ActiveModel::RangeError in Rails.
const MAX_YEAR_DIGITS = 9;

// `where(tax_year: year)` casts an Integer or the digits of one; any other value is a Ruby cast Node does not reproduce.
function taxYearFrom(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 2 ** 31) return value;
  if (typeof value === "string" && new RegExp(`^[0-9]{1,${MAX_YEAR_DIGITS}}$`, "u").test(value)) return Number(value);
  throw new NotPortedError(`where(tax_year: ${JSON.stringify(value)})`, "the year is not an Integer");
}

// `tax_form.stripe_account_id`: the json_data attribute when it is a present string. A blank or missing one makes Rails fall back to
// the seller's own Stripe account, and anything else (a number, a Hash) is a value Ruby types differently.
function stripeAccountIdOf(jsonData: unknown): string | null {
  if (typeof jsonData !== "string" || jsonData === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).stripe_account_id;
  return typeof value === "string" && /\S/u.test(value) ? value : null;
}

export const taxFormTransactionReportJobWith = modelJob({ min: 2 }, async ([userIdArg, yearArg]) => {
  const { userId, year } = await beforeSideEffects(() => ({
    userId: recordIdFrom(userIdArg, "User.find"),
    year: taxYearFrom(yearArg),
  }));
  await findByIdBang("User", userId);

  const [taxForm] = await selectRows<{ json_data: unknown }>(
    Prisma.sql`SELECT ${Prisma.raw("`user_tax_forms`.*")} FROM ${table(TAX_FORMS)} WHERE ${column(TAX_FORMS, "user_id")} = ${userId} AND ${column(TAX_FORMS, "tax_year")} = ${year} AND ${column(TAX_FORMS, "tax_form_type")} = ${US_1099_K} ORDER BY ${column(TAX_FORMS, "id")} ASC LIMIT 1`,
  );
  if (!taxForm) return;

  const accountId = stripeAccountIdOf(taxForm.json_data);
  if (accountId === null) throw new HandBackToRuby("the report falls back to the seller's own Stripe account");

  const connected = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(MERCHANT_ACCOUNTS)} WHERE ${column(MERCHANT_ACCOUNTS, "user_id")} = ${userId} AND ${column(MERCHANT_ACCOUNTS, "deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_alive_at")} IS NOT NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_id")} = ${STRIPE} AND ${column(MERCHANT_ACCOUNTS, "charge_processor_merchant_id")} = ${accountId} LIMIT 1`,
  );
  if (connected.length === 0) return;

  throw new HandBackToRuby("the transaction report is built from Stripe");
});
export const taxFormTransactionReportJob = taxFormTransactionReportJobWith();

export type TaxFormTransactionReportExhaustedDeps = {
  notify: (errorOrMessage: unknown, context: Record<string, unknown>) => void;
};

// The creator was told the email is coming, so a job that gives up is reported: `ErrorNotifier.notify(exception, context: {...})`,
// where `context:` is a keyword of its own and so reaches Sentry's extra scope as `{ context: {...} }`.
export const taxFormTransactionReportJobRetriesExhaustedWith =
  (
    deps: TaxFormTransactionReportExhaustedDeps = { notify: (error, context) => notifyError(error, context) },
  ): RetriesExhausted =>
  (msg, error) => {
    const args = msg.args;
    if (!Array.isArray(args)) return Promise.reject(new TypeError("undefined method 'first' for nil"));
    deps.notify(error, { context: { user_id: args[0] ?? null, year: args[1] ?? null } });
    return Promise.resolve();
  };
export const taxFormTransactionReportJobRetriesExhausted = taxFormTransactionReportJobRetriesExhaustedWith();
