// StripeMerchantAccountManager.handle_stripe_event_capability_updated and handle_stripe_event_account_updated, as
// HandleStripeEventWorker reaches them for a connected account, for the cases that end in local work only: the payment method
// availability refresh job and the currency mismatch markers. Stripe is never called.
// Served: `capability.updated` of an account outside Japan (or none) and `account.updated` whose object is a standard account.
// Everything else of both events reads the Stripe account, writes compliance requests or sends mail, and is handed back before the
// first write or enqueue.
// Golden: worker/jobs/__fixtures__/stripe-account-events.golden.json (scripts/golden/stripe-account-events.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../jobs/hand-back.ts";

import { performAsync } from "./concerns/job-runtime.ts";
import { jsonDataForAttr, setJsonDataForAttr } from "./concerns/json-data.ts";
import {
  isStripeConnectAccountRecord,
  MerchantAccounts,
  STRIPE_CHARGE_PROCESSOR_ID,
  type MerchantAccountRecord,
} from "./merchant-account.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { isBlank } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const REFRESH_AVAILABILITY_JOB = "RefreshMerchantAccountPaymentMethodAvailabilityWorker";
const JAPAN = "JP";
const STANDARD_ACCOUNT_TYPE = "standard";
// The previous_attributes keys that mean the account's settlement currencies may have changed.
const CURRENCY_CONFIG_ATTRIBUTES = ["default_currency", "external_accounts"];
const MISMATCH_ATTRIBUTES = ["settlement_currency_mismatch_noticed_at", "settlement_currency_mismatch_map"];

type EventObject = Record<string, unknown>;
const isObject = (value: unknown): value is EventObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// MerchantAccount.where(charge_processor_id: "stripe", charge_processor_merchant_id:).alive.charge_processor_alive.last
async function lastAliveProcessorAliveAccount(stripeAccountId: string): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${stripeAccountId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL ORDER BY ${column("merchant_accounts", "id")} DESC LIMIT 1`,
  );
  return row ? MerchantAccounts.load(castRow("MerchantAccount", row)) : null;
}

// refresh_payment_method_availability: only a Stripe Connect account has a capabilities snapshot to refresh.
async function refreshPaymentMethodAvailability(account: MerchantAccountRecord | null): Promise<void> {
  if (account === null || !isStripeConnectAccountRecord(account)) return;
  await performAsync(REFRESH_AVAILABILITY_JOB, [Number(account.get("id"))]);
}

// clear_settlement_currency_mismatch_on_currency_change. Ruby rescues every StandardError there so the rest of the event is not
// skipped; a failed validation is the one failure that happens before a write, so it is the one swallowed here.
async function clearSettlementCurrencyMismatch(
  account: MerchantAccountRecord | null,
  previousAttributes: EventObject,
  now: () => Date,
): Promise<void> {
  if (account === null) return;
  if (!CURRENCY_CONFIG_ATTRIBUTES.some((attribute) => Object.hasOwn(previousAttributes, attribute))) return;
  if (MISMATCH_ATTRIBUTES.every((attribute) => isBlank(jsonDataForAttr(account, attribute)))) return;
  for (const attribute of MISMATCH_ATTRIBUTES) setJsonDataForAttr(account, attribute, null);
  try {
    await MerchantAccounts.saveBang(account, { now });
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
  }
}

function eventObject(params: EventObject, expected: string): EventObject {
  const data = params.data;
  const object = isObject(data) ? data.object : undefined;
  if (!isObject(object) || object.object !== expected)
    throw new NotPortedError("an event without its object", "stripe_merchant_account_manager.rb handle_stripe_event_*");
  return object;
}

export async function handleStripeCapabilityUpdated(params: EventObject): Promise<void> {
  const account = await beforeSideEffects(async () => {
    const stripeAccountId = eventObject(params, "capability").account;
    if (typeof stripeAccountId !== "string")
      throw new NotPortedError("a capability whose account is not a String", "handle_stripe_event_capability_updated");
    const account = await lastAliveProcessorAliveAccount(stripeAccountId);
    // A Japanese account reads the Stripe account for its information requirements.
    if (account?.get("country") === JAPAN)
      throw new NotPortedError(
        "a capability of a Japanese account",
        "handle_stripe_event_capability_updated (Stripe::Account.retrieve)",
      );
    return account;
  });
  await refreshPaymentMethodAvailability(account);
}

export async function handleStripeAccountUpdated(params: EventObject, now: () => Date): Promise<void> {
  const { account, previous } = await beforeSideEffects(async () => {
    const stripeAccount = eventObject(params, "account");
    const previousAttributes = (params.data as EventObject).previous_attributes ?? {};
    if (typeof stripeAccount.id !== "string" || !isObject(previousAttributes))
      throw new NotPortedError(
        "an account event with an id or previous_attributes of another shape",
        "handle_stripe_event_account_updated",
      );
    // Any other account type goes on to read compliance state, requests and mail in handle_stripe_info_requirements.
    if (stripeAccount.type !== STANDARD_ACCOUNT_TYPE)
      throw new NotPortedError("an account.updated of a non-standard account", "handle_stripe_info_requirements");
    return { account: await lastAliveProcessorAliveAccount(stripeAccount.id), previous: previousAttributes };
  });
  await refreshPaymentMethodAvailability(account);
  await clearSettlementCurrencyMismatch(account, previous, now);
}
