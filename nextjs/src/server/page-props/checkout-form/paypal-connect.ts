// Checkout::FormPresenter#paypal_connect (app/presenters/checkout/form_presenter.rb): the PayPal Connect card of the checkout form.
// The connected account's email is fetched from PayPal through PaypalIntegrationRestApi, as Rails does; its calls are proved by the
// examples in spec/requests/checkout_form_paypal_connect_parity_spec.rb, replayed against a recorded stand-in.
import { Prisma, type User } from "@prisma/client";

import { encrypt as externalId } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { notifyError } from "../../infra/error-reporting.ts";
import { alpha2ByName } from "../../models/compliance-countries.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { jsonDataForAttr, UserFlags, Users } from "../../models/user.ts";
import { PaypalIntegrationRestApi } from "../../paypal/rest-api.ts";
import { requireUser, roleAdminFor, type SellerContext } from "../../policies/seller-context.ts";
import { partnerAuthToken } from "../../webhooks/paypal-webhook.ts";
import { NotPortedError } from "../not-ported.ts";
import { stripeRails } from "../settings/payments.ts";
import { activePreorders, activeSubscribers } from "../settings/stripe-disconnect.ts";
import { nativePayoutsSupported } from "../signed-in/data.ts";
import { activeBankAccount, type ComplianceInfoRow } from "../signed-in/reads.ts";

const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";
// ISO3166::Country[code].common_name of PaypalMerchantAccountManager::COUNTRY_CODES_NOT_SUPPORTED_BY_PCP, in that order.
const PCP_UNSUPPORTED_COUNTRIES: [string, string][] = [
  ["DZ", "Algeria"],
  ["BR", "Brazil"],
  ["CN", "China"],
  ["EG", "Egypt"],
  ["IN", "India"],
  ["IL", "Israel"],
  ["JP", "Japan"],
  ["FM", "Micronesia, Federated States of"],
  ["MA", "Morocco"],
  ["TR", "Türkiye"],
];
// PaypalMerchantAccountManager::COUNTRY_CODES_WITH_GRANDFATHERED_PCP
const GRANDFATHERED_PCP_COUNTRY_CODES = ["CN"];

const present = (value: string | null | undefined) => value != null && value.trim() !== "";

type PaypalAccountRow = {
  charge_processor_merchant_id: string | null;
  charge_processor_verified_at: Date | null;
  json_data: unknown;
};

async function exists(sql: Prisma.Sql) {
  return (await selectRows(sql)).length > 0;
}

// `seller.merchant_accounts.alive.paypal.first`: alive on the row, whatever the processor says.
async function paypalMerchantAccount(seller: User): Promise<PaypalAccountRow | null> {
  const [row] = await selectRows<PaypalAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
  );
  return row ?? null;
}

// User#has_paypal_account_connected?: `merchant_accounts.alive.charge_processor_alive.paypal` (a PayPal account can always accept charges).
const hasPaypalAccountConnected = (seller: User) =>
  exists(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID} LIMIT 1`,
  );

// `meta.present? && meta["isEmailConfirmed"] == "false"`. A json_data or meta that is not a Hash makes Ruby index a String or an Array.
function needsEmailConfirmation(account: PaypalAccountRow): boolean {
  const data: unknown =
    typeof account.json_data === "string"
      ? account.json_data.trim() === ""
        ? null
        : JSON.parse(account.json_data)
      : account.json_data;
  if (data === null || data === undefined) return false;
  if (typeof data !== "object" || Array.isArray(data))
    throw new NotPortedError("a PayPal account json_data that is not a hash");
  const meta = (data as Record<string, unknown>).meta;
  if (meta === null || meta === undefined) return false;
  if (typeof meta !== "object" || Array.isArray(meta))
    throw new NotPortedError("a PayPal account meta that is not a hash");
  return (meta as Record<string, unknown>).isEmailConfirmed === "false";
}

// The page's guard runs this after authorization, so a refusal still redirects from Node and a hand-back is not a 500 mid-render.
export async function assertPaypalAccountSupported(seller: User): Promise<void> {
  const account = await paypalMerchantAccount(seller);
  if (account === null) return;
  try {
    needsEmailConfirmation(account);
  } catch (error) {
    if (error instanceof NotPortedError) throw new HandBackToRails(error.message);
    throw error;
  }
}

// `parsed_response.try(:[], "primary_email")`: a Hash answers the key, a String answers the key when it contains it, and anything
// else (a list, a number) either lacks the method or raises, which the caller rescues into no email.
export function primaryEmail(parsed: unknown): unknown {
  if (typeof parsed === "string") return parsed.includes("primary_email") ? "primary_email" : null;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
    return (parsed as Record<string, unknown>).primary_email ?? null;
  return null;
}

// The email is display data: any failure, below HTTP or in the answer, leaves it out.
async function paypalEmail(seller: User, account: PaypalAccountRow): Promise<unknown> {
  try {
    const api = new PaypalIntegrationRestApi(
      { external_id: externalId(seller.id), email: seller.email },
      { authorizationHeader: await partnerAuthToken() },
    );
    const response = await api.getMerchantAccountByMerchantId(account.charge_processor_merchant_id ?? "");
    return primaryEmail(response.result);
  } catch (error) {
    notifyError(error as Error);
    return null;
  }
}

// UserComplianceInfo#legal_entity_country_code
function legalEntityCode(info: ComplianceInfoRow): string | null {
  return (info.is_business ? alpha2ByName(info.business_country) : null) ?? alpha2ByName(info.country);
}

export async function paypalConnect(seller: User, context: SellerContext, info: ComplianceInfoRow | null) {
  const bank = await activeBankAccount(seller.id);
  const record = Users.load(seller);
  const countryCode = info === null ? null : alpha2ByName(info.country);
  const paypalConnected = await hasPaypalAccountConnected(seller);
  const stripe = await stripeRails(seller);
  // User#paypal_connect_enabled?: a country PayPal Connect does not serve keeps it only for a grandfathered one with an account.
  const enabled =
    info !== null &&
    (!PCP_UNSUPPORTED_COUNTRIES.some(([code]) => code === countryCode) ||
      (GRANDFATHERED_PCP_COUNTRY_CODES.includes(countryCode ?? "") && paypalConnected));
  // Settings::Payments::UserPolicy#paypal_connect? is update?: the admin role, for the seller in context.
  const show = roleAdminFor(requireUser(context)) && enabled;
  const account = await paypalMerchantAccount(seller);
  const email = show && account !== null ? await paypalEmail(seller, account) : null;

  const payoutEmail = present(seller.payment_address);
  const disconnectAllowed =
    !(await activeSubscribers(seller.id, PAYPAL_CHARGE_PROCESSOR_ID)) &&
    !(await activePreorders(seller.id, PAYPAL_CHARGE_PROCESSOR_ID));
  const removesPayoutRail = !payoutEmail && bank === null && !stripe.hasStripeAccountConnected && paypalConnected;
  const blocksPublishing =
    removesPayoutRail &&
    !UserFlags.isSet(seller.flags, "is_team_member") &&
    !stripe.hasStripeAccount &&
    !stripe.hasStripeConnectAccount;

  const legalCountry = info === null ? null : legalEntityCode(info);
  const canCreateBankRail = (nativePayoutsSupported(info) && legalCountry !== "IN") || legalCountry === "AE";
  const canSetupBank = bank !== null || canCreateBankRail;
  const canSetupPaypal =
    payoutEmail ||
    present(jsonDataForAttr(record, "invalidated_paypal_payout_address") as string | null) ||
    !nativePayoutsSupported(info) ||
    ["AE", "EG", "KZ", "IN"].includes(legalCountry ?? "");

  return {
    show_paypal_connect: show,
    // User#paypal_connect_allowed? is #has_payout_information?
    allow_paypal_connect: bank !== null || payoutEmail || stripe.hasStripeAccountConnected || paypalConnected,
    unsupported_countries: PCP_UNSUPPORTED_COUNTRIES.map(([, name]) => name),
    email,
    charge_processor_merchant_id: account?.charge_processor_merchant_id ?? null,
    charge_processor_verified: account?.charge_processor_verified_at != null,
    needs_email_confirmation: account !== null && needsEmailConfirmation(account),
    paypal_disconnect_allowed: disconnectAllowed,
    paypal_disconnect_removes_payout_rail: removesPayoutRail,
    paypal_disconnect_blocks_publishing: blocksPublishing,
    payout_setup_method: canSetupBank && !canSetupPaypal ? "bank_account" : "paypal_email",
  };
}
