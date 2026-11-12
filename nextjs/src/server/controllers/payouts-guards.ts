// The guards of the payout actions that move money, call Stripe or enqueue a job: Settings::StripeController#disconnect,
// InstantPayoutsController#create, TaxCenterController#download and #request_transaction_report, and
// OauthCompletionsController#stripe.
//
// Ported: sign-in, the account email, the tax center switch, the Pundit refusals, the tax form lookups and the missing OAuth session.
// Ported past the guards: the Stripe disconnect (a local write, no Stripe call) and the instant payout (models/instant-payouts-service.ts;
// a shape Node does not take is handed to Rails whole before the first write or Stripe POST). Handed to Rails whole, before any write or
// processor call: the tax form download, the transaction report job and linking the Stripe account.
import { Prisma } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { notifyError } from "../infra/error-reporting.ts";
import { INSTANT_PAYOUT_FAILED, performInstantPayouts } from "../models/instant-payouts-service.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { disconnectStripe } from "../models/stripe-merchant-account-disconnect.ts";
import { findUserBang, NotPortedError } from "../models/user.ts";
import { transactionReportAvailable, taxCenterEnabled } from "../page-props/dashboard/tax-center.ts";
import { domainConfig } from "../page-props/domain.ts";
import { settingsGuard } from "../page-props/settings/guard.ts";
import { authorize } from "../policies/authorize.ts";
import { balancePolicy } from "../policies/balance.ts";
import { instantPayoutPolicy } from "../policies/instant-payout.ts";
import { type SellerContext } from "../policies/seller-context.ts";
import { settingsPaymentsUserPolicy } from "../policies/settings/payments-user.ts";

import { HandBackToRails, type ActionResult, type Redirected } from "./application-controller.ts";
import { jsonResponse, sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson } from "./seller-json.ts";
import { logPayoutSettingsUpdateByNonOwner } from "./settings-payments-mutations.ts";
import { requestFormat } from "./signed-in-filters.ts";

const FOUND = 302;
const NOT_FOUND = 404;
const TAX_FORM_UNAVAILABLE = "Tax form not available for download.";
const REPORT_UNAVAILABLE = "Transaction report not available.";
const TAX_CENTER_DISABLED = "Tax center is not enabled for your account.";
const INVALID_OAUTH_SESSION = "Invalid OAuth session";
// An external-id-sized year is far below this; a longer one is a bignum Node does not compare.
const MAX_YEAR_DIGITS = 15;

async function guard(input: MutationInput, authorize: (context: SellerContext) => boolean): Promise<Redirected | null> {
  return settingsGuard({ authorize })({
    context: input.context,
    config: domainConfig(process.env),
    url: input.url,
    params: input.routeParams,
    urlOptions: input.urlOptions,
  });
}

// POST /settings/stripe/disconnect
function disconnect(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    (context) => settingsPaymentsUserPolicy.stripeConnect(context, context.seller!),
    async () => {
      const { success, hadConnectedAccount } = await disconnectStripe(
        await findUserBang(input.context.currentSeller!.id),
      );
      // The manager reports success for a no-op too, so the note needs an account that was there to remove.
      if (success && hadConnectedAccount) await logPayoutSettingsUpdateByNonOwner(input, "Stripe account disconnected");
      return jsonResponse({ success });
    },
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT_PAYOUT_NOTICE = "Instant payout initiated successfully";

// `Date.parse(params.require(:date))`, for the one shape the dashboard sends. Anything else (a missing or blank param, another
// format) goes to Rails before any read.
function instantPayoutDate(input: MutationInput): Date {
  const value = input.params.date;
  const match = typeof value === "string" ? ISO_DATE.exec(value) : null;
  if (match === null) throw new HandBackToRails("an instant payout date that is not a YYYY-MM-DD string");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value)
    throw new HandBackToRails("an instant payout date that is not a calendar day");
  return date;
}

// POST /instant_payouts. Everything up to the claim of the balances only reads, so a shape Node refuses (NotPortedError), a failed
// Stripe read or any other error there hands the whole request to Rails. Once a payment may exist nothing is thrown: an error is
// reported and the seller is told the payout failed, because Rails would pay again.
async function createInstantPayout(input: MutationInput): Promise<ActionResult> {
  const denied = await guard(input, instantPayoutPolicy.create);
  // Pundit answers a refusal with 401 JSON unless the request is HTML; only the HTML redirect is ported.
  if (denied && requestFormat(input.request) !== "html")
    throw new HandBackToRails("a refused instant payout in another format");
  if (denied) return denied;
  const date = instantPayoutDate(input);
  const progress = { committed: false };
  const redirect = (flash: Record<string, string>): Redirected => ({
    status: FOUND,
    location: Routes.balance_url(input.urlOptions),
    flash,
  });
  try {
    const seller = await findUserBang(Number(input.context.currentSeller!.id));
    const result = await performInstantPayouts(seller, date, {}, progress);
    return redirect(result.success ? { notice: INSTANT_PAYOUT_NOTICE } : { alert: result.error });
  } catch (error) {
    if (!progress.committed)
      throw error instanceof HandBackToRails
        ? error
        : new HandBackToRails(
            error instanceof NotPortedError
              ? error.message
              : `an instant payout that failed before it claimed anything: ${String(error)}`,
          );
    notifyError(error);
    return redirect({ alert: INSTANT_PAYOUT_FAILED });
  }
}

// `params[:year].to_i`; null when the number is too long to hold exactly.
function yearOf(input: MutationInput): number | null {
  const digits = /^\s*([-+]?)(\d+(?:_\d+)*)/u.exec(input.routeParams.year ?? "");
  if (digits === null) return 0;
  const text = digits[2]!.replaceAll("_", "");
  return text.length > MAX_YEAR_DIGITS ? null : Number(`${digits[1] === "-" ? "-" : ""}${text}`);
}

// TaxCenterController#ensure_tax_center_enabled
async function taxCenterDisabled(input: MutationInput): Promise<Redirected | null> {
  if (await taxCenterEnabled(input.context.currentSeller!.id)) return null;
  return {
    status: FOUND,
    location: Routes.dashboard_url(input.urlOptions),
    rescued: true,
    flash: { alert: TAX_CENTER_DISABLED },
  };
}

async function taxFormRow(sellerId: bigint, year: number, formType: string) {
  const [row] = await selectRows<{ json_data: string | null }>(
    Prisma.sql`SELECT ${column("user_tax_forms", "json_data")} FROM ${table("user_tax_forms")} WHERE ${column("user_tax_forms", "user_id")} = ${sellerId} AND ${column("user_tax_forms", "tax_year")} = ${year} AND ${column("user_tax_forms", "tax_form_type")} = ${formType} ORDER BY ${column("user_tax_forms", "id")} ASC LIMIT 1`,
  );
  return row ?? null;
}

// GET /payouts/taxes/:year/:form_type/download
async function downloadTaxForm(input: MutationInput): Promise<ActionResult> {
  // Sellers::BaseController's account email check runs ahead of the tax center switch, the policy after it.
  const noEmail = await guard(input, () => true);
  if (noEmail) return noEmail;
  const disabled = await taxCenterDisabled(input);
  if (disabled) return disabled;
  const denied = await guard(input, balancePolicy.index);
  if (denied) return denied;

  const year = yearOf(input);
  if (year === null) throw new HandBackToRails("a year that is not a small integer");
  if ((await taxFormRow(input.context.currentSeller!.id, year, input.routeParams.form_type ?? "")) === null)
    return {
      status: FOUND,
      location: `${Routes.tax_center_path()}?year=${year}`,
      flash: { alert: TAX_FORM_UNAVAILABLE },
    };
  throw new HandBackToRails("a tax form download fetches the PDF from Stripe");
}

// POST /payouts/taxes/:year/transaction_report
function requestTransactionReport(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(
    input,
    () => true,
    async () => {
      const disabled = await taxCenterDisabled(input);
      if (disabled) return disabled;
      const denied = await authorizeJson(input, (context) => authorize(balancePolicy.index, context));
      if (denied) return denied;

      const year = yearOf(input);
      if (year === null) throw new HandBackToRails("a year that is not a small integer");
      const sellerId = input.context.currentSeller!.id;
      const form = await taxFormRow(sellerId, year, "us_1099_k");
      const notAvailable = jsonResponse({ success: false, error: REPORT_UNAVAILABLE }, NOT_FOUND, true);
      if (form === null) return notAvailable;

      const data = form.json_data ? (JSON.parse(form.json_data) as Record<string, unknown>) : {};
      const accountId = data.stripe_account_id;
      if (accountId !== undefined && accountId !== null && typeof accountId !== "string")
        throw new HandBackToRails("a stripe_account_id that is not text");
      if (
        !(await transactionReportAvailable(
          sellerId,
          { tax_form_type: "us_1099_k", json_data: form.json_data },
          accountId ?? null,
        ))
      )
        return notAvailable;
      throw new HandBackToRails(
        "the transaction report is built by a job that pages through Stripe balance transactions",
      );
    },
  );
}

// GET /oauth_completions/stripe
async function completeStripeOauth(input: MutationInput): Promise<ActionResult> {
  const connect = input.chain.session.data.stripe_connect_data;
  const hash =
    connect !== null && typeof connect === "object" && !Array.isArray(connect)
      ? (connect as Record<string, unknown>)
      : null;
  const missing =
    connect === undefined ||
    connect === null ||
    connect === false ||
    (hash !== null && (hash.auth_uid ?? false) === false);
  if (!missing)
    throw new HandBackToRails("linking the Stripe account retrieves it from Stripe and writes the merchant account");
  return { status: FOUND, location: Routes.settings_payments_path(), flash: { alert: INVALID_OAUTH_SESSION } };
}

registerMutations(
  { method: "POST", pattern: "/settings/stripe/disconnect", formats: ["json"], run: disconnect },
  { method: "POST", pattern: "/instant_payouts", formats: ["any"], run: createInstantPayout },
  {
    method: "GET",
    pattern: "/payouts/taxes/:year/:form_type/download",
    skipForgeryProtection: true,
    run: downloadTaxForm,
  },
  {
    method: "POST",
    pattern: "/payouts/taxes/:year/transaction_report",
    formats: ["json"],
    run: requestTransactionReport,
  },
  { method: "GET", pattern: "/oauth_completions/stripe", skipForgeryProtection: true, run: completeStripeOauth },
);
