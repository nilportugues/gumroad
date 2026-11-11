// StripeMerchantAccountManager.disconnect (app/business/payments/merchant_registration/implementations/stripe/
// stripe_merchant_account_manager.rb). Unlike the account creation and update paths it makes no Stripe call:
// `delete_charge_processor_account!` of a Connect account only marks the local row, so the whole disconnect is
// database writes. Each write below is its own transaction, in the order Rails runs them.
import { Prisma, type MerchantAccount } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { stripeDisconnectAllowed } from "../page-props/settings/stripe-disconnect.ts";

import {
  aliveStripeAccountsOf,
  isStripeConnectAccount,
  MerchantAccountDeletable,
  MerchantAccounts,
  STRIPE_CHARGE_PROCESSOR_ID,
  type MerchantAccountRecord,
  type MerchantAccountRow,
} from "./merchant-account.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import {
  stripeConnectRoutingCountryCode,
  isSupportedByStripeConnect,
  LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE,
} from "./stripe-connect-routing.ts";
import { aliveUserComplianceInfoRow } from "./user-compliance-info.ts";
import { isFlagSet, NotPortedError, setFlag, Users, type UserRecord } from "./user.ts";

const MERCHANT_MIGRATION_FEATURE = "merchant_migration";
const DISCONNECT_REF = "stripe_merchant_account_manager.rb StripeMerchantAccountManager.disconnect";

// User#merchant_migration_enabled?
async function merchantMigrationEnabled(seller: UserRecord): Promise<boolean> {
  if (isFlagSet(seller, "check_merchant_account_is_linked")) return true;
  const actor = userActor(seller.get("id"));
  if (!(await isFeatureEnabled(MERCHANT_MIGRATION_FEATURE, actor))) return false;
  const info = await aliveUserComplianceInfoRow(seller.get("id"));
  if (info === null) return false;
  const legalEntityRouting = await isFeatureEnabled(LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE, actor);
  return isSupportedByStripeConnect(stripeConnectRoutingCountryCode(info, legalEntityRouting));
}

// `user.stripe_connect_account`
export async function stripeConnectAccountOf(userId: unknown): Promise<MerchantAccountRow | null> {
  return (await aliveStripeAccountsOf(userId)).find((account) => isStripeConnectAccount(account)) ?? null;
}

const loadAccount = (row: unknown): MerchantAccountRecord =>
  MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row as Record<string, unknown>));

// `reactivatable.where(...).last`: the highest id of the user's Stripe accounts not retired by adoption.
async function lastReactivatable(userId: unknown, condition: Prisma.Sql): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID} AND json_data->>'$.retired_by_adoption_at' IS NULL AND ${condition} ORDER BY ${column("merchant_accounts", "id")} DESC LIMIT 1`,
  );
  return row ? loadAccount(row) : null;
}

// Old Gumroad-managed account of the seller: the one holding an unpaid balance, else the one named by the active bank account.
async function reactivatableAccount(userId: unknown): Promise<MerchantAccountRecord | null> {
  const balances = await selectRows<{ merchant_account_id: unknown }>(
    Prisma.sql`SELECT DISTINCT ${column("balances", "merchant_account_id")} FROM ${table("balances")} WHERE ${column("balances", "user_id")} = ${userId} AND ${column("balances", "state")} = 'unpaid'`,
  );
  const ids = balances.map((balance) => balance.merchant_account_id).filter((id) => id != null);
  // `where(id: [])` is a false condition; a NULL in the list is dropped by IN.
  const byBalance = await lastReactivatable(
    userId,
    ids.length === 0 ? Prisma.sql`1 = 0` : Prisma.sql`${column("merchant_accounts", "id")} IN (${Prisma.join(ids)})`,
  );
  if (byBalance) return byBalance;
  const [bank] = await selectRows<{ stripe_connect_account_id: string | null }>(
    Prisma.sql`SELECT ${column("bank_accounts", "stripe_connect_account_id")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC LIMIT 1`,
  );
  // `where(charge_processor_merchant_id: nil)` matches rows with no id, which the blank check below then drops.
  if (bank?.stripe_connect_account_id == null) return null;
  return lastReactivatable(
    userId,
    Prisma.sql`${column("merchant_accounts", "charge_processor_merchant_id")} = ${bank.stripe_connect_account_id}`,
  );
}

export type StripeDisconnect = { success: boolean; hadConnectedAccount: boolean };

export async function disconnectStripe(seller: UserRecord): Promise<StripeDisconnect> {
  const sellerId = seller.get("id");
  const connectRow = await stripeConnectAccountOf(sellerId);
  const hadConnectedAccount = connectRow !== null;

  const connected = connectRow !== null && (await merchantMigrationEnabled(seller));
  if (connected && !(await stripeDisconnectAllowed(sellerId, connectRow.id)))
    return { success: false, hadConnectedAccount };

  // Rails calls `delete_charge_processor_account!` on nil here and answers 500; a non-Hash json_data is reset first.
  if (connectRow === null) throw new NotPortedError("a disconnect with no Stripe Connect account", DISCONNECT_REF);
  if (
    connectRow.json_data != null &&
    (typeof connectRow.json_data !== "string" || !/^\s*\{/u.test(connectRow.json_data))
  )
    throw new NotPortedError(
      "a Connect account whose json_data is not a Hash",
      "merchant_account.rb clear_non_hash_json_data_for_disconnect!",
    );

  // The user is saved after the account is marked deleted, in a transaction of its own. Judge it first, so a seller that no
  // longer validates goes to Rails before anything is written.
  setFlag(seller, "check_merchant_account_is_linked", false);
  if (!(await Users.valid(seller))) throw new NotPortedError("a seller that fails validation", "user.rb validations");

  const account = loadAccount(connectRow);
  try {
    await MerchantAccountDeletable.markDeletedBang(account);
  } catch (error) {
    // Nothing was written: the save validates before its INSERT or UPDATE.
    if (error instanceof RecordInvalid)
      throw new NotPortedError("a Connect account that fails validation", "merchant_account.rb validations");
    throw error;
  }
  account.set("charge_processor_deleted_at", new Date());
  account.set("charge_processor_alive_at", null);
  account.set("charge_processor_verified_at", null);
  await MerchantAccounts.saveBang(account);
  await Users.saveBang(seller);

  const reactivate = await reactivatableAccount(sellerId);
  if (
    reactivate === null ||
    reactivate.get("charge_processor_merchant_id") == null ||
    String(reactivate.get("charge_processor_merchant_id")).trim() === ""
  )
    return { success: true, hadConnectedAccount };
  reactivate.set("deleted_at", null);
  reactivate.set("charge_processor_deleted_at", null);
  reactivate.set("charge_processor_alive_at", new Date());
  await MerchantAccounts.saveBang(reactivate);
  return { success: true, hadConnectedAccount };
}
