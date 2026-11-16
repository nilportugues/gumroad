// PaypalMerchantAccountManager#update_merchant_account (app/business/payments/merchant_registration/implementations/paypal/
// paypal_merchant_account_manager.rb) as Settings::PaymentsController#paypal_connect calls it: a new connection, with no
// confirmation email requested. The order is Rails': the row is saved first, then PayPal is asked about the merchant (an OAuth
// token only when none is cached), then the row is judged, saved again and the other PayPal accounts of the seller are retired.
//
// A 2xx answer from PayPal that is not a JSON object is a NotPortedError raised after the first save: Rails fails there too, and
// nothing the recordings can show says what the retry would do.
import { Prisma, type MerchantAccount, type User } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { getConfig } from "../infra/config.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { payoutFacts } from "../page-props/settings/payments.ts";
import { PaypalIntegrationRestApi } from "../paypal/rest-api.ts";
import { partnerAuthToken } from "../webhooks/paypal-webhook.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { jsonData, setJsonDataForAttr } from "./concerns/json-data.ts";
import { MerchantAccountDeletable, MerchantAccounts, type MerchantAccountRecord } from "./merchant-account.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";
const REF = "paypal_merchant_account_manager.rb PaypalMerchantAccountManager#update_merchant_account";
const MAILER = "MerchantRegistrationMailer";
const MAIL_QUEUE = "default";
const PAYPAL_PAYOUT_PROCESSOR = "PAYPAL";
const FAILED_PAYMENT = "failed";
const COMPLETED_PAYMENT = "completed";
// Payment::FailureReason::TERMINAL_PAYPAL_FAILURE_REASONS
const TERMINAL_PAYPAL_FAILURE_REASONS = ["PAYPAL 3148"];
// COUNTRY_CODES_NOT_SUPPORTED_BY_PCP: DZA, BRA, CHN, EGY, IND, ISR, JPN, FSM, MAR, TUR
const COUNTRY_CODES_NOT_SUPPORTED_BY_PCP = ["DZ", "BR", "CN", "EG", "IN", "IL", "JP", "FM", "MA", "TR"];

const ERROR_MESSAGE = "There was an error connecting your PayPal account with Gumroad.";
const NOT_ELIGIBLE_MESSAGE =
  "Your PayPal account could not be connected because you do not meet the eligibility requirements.";
const REFUSED_PAYOUT_MESSAGE =
  "PayPal won't accept payouts to that account. Please connect a different PayPal account.";
const UNSUPPORTED_COUNTRY_MESSAGE =
  "Your PayPal account could not be connected because this PayPal integration is not supported in your country.";
const CONNECTED_MESSAGE = "You have successfully connected your PayPal account with Gumroad.";
const NOT_RECEIVABLE_MESSAGE =
  "PayPal reports that your account cannot receive payments right now. Please resolve the restriction or outstanding requirement on your PayPal account, then try connecting again.";
const MISSING_PERMISSIONS_MESSAGE =
  "Your PayPal account connect with Gumroad is incomplete because of missing permissions. Please try connecting again and grant the requested permissions.";

type Details = Record<string, unknown>;

const isObject = (value: unknown): value is Details =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// Ruby truthiness: only nil and false are falsy.
const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false;
// Array.wrap
const wrap = (value: unknown): unknown[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

// `user.paypal_connect_allowed?`, i.e. `has_payout_information?`.
async function paypalConnectAllowed(seller: User): Promise<boolean> {
  if ((await db.bankAccount.count({ where: { user_id: Number(seller.id), deleted_at: null } })) > 0) return true;
  if (!isBlank(seller.payment_address)) return true;
  if ((await payoutFacts(seller)).stripeConnectRoutingActive) return true;
  return (
    (await db.merchantAccount.count({
      where: {
        user_id: seller.id,
        deleted_at: null,
        charge_processor_id: PAYPAL_CHARGE_PROCESSOR_ID,
        charge_processor_alive_at: { not: null },
        charge_processor_deleted_at: null,
      },
    })) > 0
  );
}

// PaypalPayoutProcessor.terminal_failure_for_payout_email?
async function terminalFailureForPayoutEmail(userId: bigint, email: string): Promise<boolean> {
  const toAddress = { user_id: userId, processor: PAYPAL_PAYOUT_PROCESSOR, payment_address: email };
  const failed = { ...toAddress, state: FAILED_PAYMENT, failure_reason: { in: TERMINAL_PAYPAL_FAILURE_REASONS } };
  if ((await db.payment.count({ where: failed })) === 0) return false;
  const lastCompleted = (
    await db.payment.aggregate({ where: { ...toAddress, state: COMPLETED_PAYMENT }, _max: { created_at: true } })
  )._max.created_at;
  if (lastCompleted === null) return true;
  return (await db.payment.count({ where: { ...failed, created_at: { gt: lastCompleted } } })) > 0;
}

// MerchantAccount#paypal_account_details: nil unless PayPal answers 2xx.
async function paypalAccountDetails(seller: User, account: MerchantAccountRecord): Promise<Details | null> {
  const api = new PaypalIntegrationRestApi(
    { external_id: seller.external_id ?? "", email: seller.email },
    { authorizationHeader: await partnerAuthToken() },
  );
  const response = await api.getMerchantAccountByMerchantId(String(account.get("charge_processor_merchant_id")));
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  if (!isObject(response.result)) throw new NotPortedError("a PayPal merchant answer that is not an object", REF);
  // PayPal reports China as C2.
  if (response.result.country === "C2") response.result.country = "CN";
  return response.result;
}

// MerchantAccount#delete_charge_processor_account! for an account that is not a Stripe Connect one: two saves.
async function deleteChargeProcessorAccount(account: MerchantAccountRecord): Promise<void> {
  await MerchantAccountDeletable.markDeletedBang(account);
  setJsonDataForAttr(account, "meta", {});
  account.set("charge_processor_deleted_at", new Date());
  account.set("charge_processor_alive_at", null);
  account.set("charge_processor_verified_at", null);
  await MerchantAccounts.saveBang(account);
}

const rubyString = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

async function sendAccountUpdatedMail(userId: bigint): Promise<void> {
  await deliverLater(
    currentJobsRuntime(),
    { mailer: MAILER, method: "paypal_account_updated", args: [Number(userId)], queue: MAIL_QUEUE },
    mailRoute(MAILER, "paypal_account_updated"),
  );
}

function hasPartnerGrant(integrations: unknown): boolean {
  const partnerClientId = getConfig("PAYPAL_PARTNER_CLIENT_ID");
  return wrap(integrations).some(
    (integration) =>
      isObject(integration) &&
      integration.integration_type === "OAUTH_THIRD_PARTY" &&
      integration.integration_method === "PAYPAL" &&
      wrap(integration.oauth_third_party).some(
        (grant) => isObject(grant) && partnerClientId !== undefined && grant.partner_client_id === partnerClientId,
      ),
  );
}

// The account row `user.merchant_accounts.where(...).first_or_initialize`: the lowest id for this merchant, deleted or not.
async function firstOrInitialize(seller: User, paypalMerchantId: string): Promise<MerchantAccountRecord> {
  const [row] = await selectRows(
    Prisma.sql`SELECT * FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${paypalMerchantId} ORDER BY ${column("merchant_accounts", "id")} ASC LIMIT 1`,
  );
  if (row === undefined)
    return MerchantAccounts.build({
      user_id: seller.id,
      charge_processor_id: PAYPAL_CHARGE_PROCESSOR_ID,
      charge_processor_merchant_id: paypalMerchantId,
    } as Partial<MerchantAccount>);
  const account = MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row));
  // `clear_non_hash_json_data_for_disconnect!` is the only guard Rails has for a corrupt column; `meta=` raises on one.
  jsonData(account);
  return account;
}

// Returns the notice Rails flashes, or null when it answers without one.
export async function updatePaypalMerchantAccount(
  seller: User,
  paypalMerchantId: string,
  meta: Record<string, string>,
): Promise<string | null> {
  if (!(await paypalConnectAllowed(seller))) return NOT_ELIGIBLE_MESSAGE;

  const account = await firstOrInitialize(seller, paypalMerchantId);
  account.set("deleted_at", null);
  account.set("charge_processor_deleted_at", null);
  account.set("charge_processor_merchant_id", paypalMerchantId);
  if (Object.keys(meta).length > 0) setJsonDataForAttr(account, "meta", meta);

  const accountChanged = account.hasChangesToSave();
  // Read before the save, which is what un-deletes a row.
  const alreadyVerified = account.get("charge_processor_verified_at") != null;

  if (!(await MerchantAccounts.save(account))) return ERROR_MESSAGE;

  let details: Details | null = null;
  if (!alreadyVerified) {
    details = await paypalAccountDetails(seller, account);
    const connectedEmail = details?.primary_email;
    if (truthy(connectedEmail) && !isBlank(connectedEmail) && typeof connectedEmail !== "string")
      throw new NotPortedError("a PayPal primary email that is not text", REF);
    if (
      typeof connectedEmail === "string" &&
      !isBlank(connectedEmail) &&
      (await terminalFailureForPayoutEmail(seller.id, connectedEmail))
    ) {
      await deleteChargeProcessorAccount(account);
      return REFUSED_PAYOUT_MESSAGE;
    }
  }

  if (account.get("charge_processor_verified_at") != null) {
    if (accountChanged) await sendAccountUpdatedMail(seller.id);
    return CONNECTED_MESSAGE;
  }

  details ??= await paypalAccountDetails(seller, account);
  if (details === null || Object.keys(details).length === 0) return null;

  const country = details.country;
  if (typeof country === "string" && COUNTRY_CODES_NOT_SUPPORTED_BY_PCP.includes(country)) {
    await deleteChargeProcessorAccount(account);
    return UNSUPPORTED_COUNTRY_MESSAGE;
  }

  if (truthy(country) && truthy(details.primary_currency)) {
    if (typeof country !== "string" || typeof details.primary_currency !== "string")
      throw new NotPortedError("a PayPal country or currency that is not text", REF);
    account.set("country", country);
    account.set("currency", details.primary_currency.toLowerCase());
    if (!(await MerchantAccounts.save(account))) return ERROR_MESSAGE;
  }

  const confirmed = truthy(details.primary_email_confirmed);
  if (hasPartnerGrant(details.oauth_integrations) && confirmed && truthy(details.payments_receivable)) {
    account.set("charge_processor_alive_at", new Date());
    account.set("charge_processor_verified_at", new Date());
    await MerchantAccounts.saveBang(account);
    await sendAccountUpdatedMail(seller.id);
    const others = await selectRows(
      Prisma.sql`SELECT * FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${seller.id} AND ${column("merchant_accounts", "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID} AND ${column("merchant_accounts", "id")} != ${account.get("id")}`,
    );
    for (const row of others)
      await deleteChargeProcessorAccount(MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row)));
    return CONNECTED_MESSAGE;
  }

  account.set("charge_processor_alive_at", null);
  account.set("charge_processor_verified_at", null);
  await MerchantAccounts.saveBang(account);
  if (confirmed && details.payments_receivable === false) return NOT_RECEIVABLE_MESSAGE;
  if (confirmed) return MISSING_PERMISSIONS_MESSAGE;
  return `You need to confirm the email address (${rubyString(details.primary_email)}) attached to your PayPal account before you can start using it with Gumroad.`;
}
