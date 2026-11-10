// User#has_valid_payout_info? and the merchant account reads behind it, for the branches that need
// nothing beyond SQL. A PayPal Connect seller without a payment address would need PayPal's account
// details over HTTP, which are not ported.
import { Prisma } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../../infra/flipper.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import {
  isSupportedByStripeConnect,
  LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE,
  stripeConnectRoutingCountryCode,
} from "../../models/stripe-connect-routing.ts";
import { isValidEmailFormat, UserFlags } from "../../models/user.ts";
import { findUserById } from "../../presenters/product-reads.ts";
import { NotPortedError } from "../not-ported.ts";
import { activeBankAccount, aliveComplianceInfo } from "../signed-in/reads.ts";

type MerchantAccount = { charge_processor_id: string | null; country: string | null; connect: boolean };

// merchant_accounts.alive.charge_processor_alive
async function liveMerchantAccounts(userId: bigint): Promise<MerchantAccount[]> {
  const m = (name: string) => column("merchant_accounts", name);
  return selectRows<MerchantAccount>(
    Prisma.sql`SELECT ${m("charge_processor_id")} AS charge_processor_id, ${m("country")} AS country, (${m("charge_processor_id")} = 'stripe' AND JSON_UNQUOTE(JSON_EXTRACT(${m("json_data")}, '$.meta.stripe_connect')) = 'true') AS connect FROM ${table("merchant_accounts")} WHERE ${m("user_id")} = ${userId} AND ${m("deleted_at")} IS NULL AND ${m("charge_processor_alive_at")} IS NOT NULL AND ${m("charge_processor_deleted_at")} IS NULL ORDER BY ${m("id")} ASC`,
  );
}

// User#merchant_migration_enabled?, which decides whether `merchant_account(stripe)` is the Connect account at all.
async function merchantMigrationEnabled(userId: bigint): Promise<boolean> {
  const user = await findUserById(userId);
  if (user && UserFlags.isSet(user.flags as bigint, "check_merchant_account_is_linked")) return true;
  const actor = userActor(userId);
  if (!(await isFeatureEnabled("merchant_migration", actor))) return false;
  const info = await aliveComplianceInfo(userId);
  if (info === null) return false;
  const legalEntityRouting = await isFeatureEnabled(LEGAL_ENTITY_COUNTRY_ROUTING_FEATURE, actor);
  return isSupportedByStripeConnect(stripeConnectRoutingCountryCode(info, legalEntityRouting));
}

// User#has_brazilian_stripe_connect_account?: `merchant_account(stripe)` is the first live Connect account when
// migration is enabled and a Gumroad-managed account otherwise, so only a Connect account behind it can be Brazilian.
export async function hasBrazilianStripeConnectAccount(userId: bigint): Promise<boolean> {
  const connect = (await aliveStripeAccountsOf(userId)).find(isStripeConnectAccount);
  if (!connect || connect.country !== "BR") return false;
  return merchantMigrationEnabled(userId);
}

export async function hasValidPayoutInfo(user: { id: bigint; payment_address: string | null }): Promise<boolean> {
  const accounts = await liveMerchantAccounts(user.id);
  const paypalConnected = accounts.some((account) => account.charge_processor_id === "paypal");
  const connect = accounts.find((account) => Number(account.connect) === 1);
  // StripePayoutProcessor.has_valid_payout_info?: a connected account is paid by Stripe directly, except a
  // Brazilian one, which falls through to the bank checks.
  if (connect && connect.country !== "BR" && (await merchantMigrationEnabled(user.id))) return true;
  if (await stripeInfoValid(user.id, accounts)) return true;

  // PaypalPayoutProcessor.has_valid_payout_info?: the payout email is the payment address, else the one PayPal
  // reports for the connected account, which only an API call can read.
  const email = user.payment_address;
  if (email === null || email.trim() === "") {
    if (paypalConnected) throw new NotPortedError("User#paypal_payout_email from a PayPal Connect account's details");
    return false;
  }
  if (!isValidEmailFormat(email) || !/^[\x00-\x7f]*$/.test(email)) return false;
  return paypalConnected || (await legalEntityName(user.id)) !== "";
}
async function stripeInfoValid(userId: bigint, accounts: MerchantAccount[]): Promise<boolean> {
  const bank = await activeBankAccount(userId);
  if (bank === null) return false;
  const [row] = await selectRows<{ stripe_bank_account_id: string | null }>(
    Prisma.sql`SELECT ${column("bank_accounts", "stripe_bank_account_id")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${userId} AND ${column("bank_accounts", "deleted_at")} IS NULL ORDER BY ${column("bank_accounts", "id")} ASC LIMIT 1`,
  );
  if ((row?.stripe_bank_account_id ?? "").trim() === "") return false;
  return accounts.some((account) => account.charge_processor_id === "stripe" && Number(account.connect) !== 1);
}

// `alive_user_compliance_info.try(:legal_entity_name)`, blank-normalised: "" when there is no info.
async function legalEntityName(userId: bigint): Promise<string> {
  const c = (name: string) => column("user_compliance_info", name);
  const [row] = await selectRows<{ is_business: number | boolean | null; business_name: string | null; first_name: string | null; last_name: string | null }>(
    Prisma.sql`SELECT ${c("is_business")}, ${c("business_name")}, ${c("first_name")}, ${c("last_name")} FROM ${table("user_compliance_info")} WHERE ${c("user_id")} = ${userId} AND ${c("deleted_at")} IS NULL ORDER BY ${c("id")} DESC LIMIT 1`,
  );
  if (!row) return "";
  if (Number(row.is_business) === 1) return (row.business_name ?? "").trim();
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.replace(/ {2,}/g, " ").trim();
}
