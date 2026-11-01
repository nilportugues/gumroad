// The parts of app/models/merchant_account.rb (and User#stripe_account) the ported jobs read. No
// writes: MerchantAccount's save callbacks are not ported.
import { Prisma, type MerchantAccount } from "@prisma/client";

import { readBelongsTo } from "./concerns/belongs-to-record.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError, Users } from "./user.ts";

export const STRIPE_CHARGE_PROCESSOR_ID = "stripe";

export type MerchantAccountRow = {
  id: unknown;
  user_id: unknown;
  charge_processor_id: unknown;
  charge_processor_merchant_id: unknown;
  country: unknown;
  json_data: unknown;
};

// MerchantAccount#json_data.dig("meta", "stripe_connect"). JsonData's JSON coder reads a blank
// column as nil, which json_data turns into {}.
export function stripeConnectMeta(jsonData: unknown): unknown {
  const data: unknown = typeof jsonData === "string" ? (jsonData.trim() === "" ? null : JSON.parse(jsonData)) : jsonData;
  if (data == null) return undefined;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("json_data must be a hash");
  const meta = (data as Record<string, unknown>).meta;
  if (meta == null) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("json_data meta is not a Hash");
  return (meta as Record<string, unknown>).stripe_connect;
}

export const isStripeConnectAccount = (account: MerchantAccountRow) =>
  account.charge_processor_id === STRIPE_CHARGE_PROCESSOR_ID && account.user_id != null && stripeConnectMeta(account.json_data) === "true";

// MerchantAccount#is_a_gumroad_managed_stripe_account?
export const isGumroadManagedStripeAccount = (account: MerchantAccountRow) =>
  account.charge_processor_id === STRIPE_CHARGE_PROCESSOR_ID && stripeConnectMeta(account.json_data) !== "true";

// `user.merchant_accounts.alive.charge_processor_alive.stripe`
export function aliveStripeAccountsOf(userId: unknown): Promise<MerchantAccountRow[]> {
  return selectRows<MerchantAccountRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID}`,
  );
}

// User#stripe_account: the first non-Connect account of those, picked in Ruby.
export async function stripeAccountOf(userId: unknown): Promise<MerchantAccountRow | null> {
  return (await aliveStripeAccountsOf(userId)).find((account) => !isStripeConnectAccount(account)) ?? null;
}

// MerchantAccount as a record, for the models that hold one (Credit, Balance, BalanceTransaction).
// Its save callbacks are not ported, so it is only ever loaded.
export type MerchantAccountRecord = ModelRecord<MerchantAccount>;
export const MerchantAccounts = defineModel<MerchantAccount>({
  rubyClass: "MerchantAccount",
  prismaModel: "MerchantAccount",
  delegate: (tx) => tx.merchantAccount as never,
});

// MerchantAccount.find_by(charge_processor_merchant_id:)
export async function findMerchantAccountByProcessorMerchantId(id: string): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "charge_processor_merchant_id")} = ${id} LIMIT 1`,
  );
  return row ? MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row)) : null;
}

// `merchant_account.user`
export const merchantAccountUser = (account: MerchantAccountRecord) =>
  readBelongsTo(account, { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" }, Users);

export const HOLDER_OF_FUNDS = { GUMROAD: "gumroad", STRIPE: "stripe", CREATOR: "creator" } as const;

// MerchantAccount#is_a_stripe_connect_account?
export const isStripeConnectAccountRecord = (account: MerchantAccountRecord) =>
  account.get("charge_processor_id") === STRIPE_CHARGE_PROCESSOR_ID && account.get("user_id") != null && stripeConnectMeta(account.get("json_data")) === "true";

// MerchantAccount#holder_of_funds for a Stripe account (StripeChargeProcessor#holder_of_funds);
// the other processors' rules are not ported.
export async function holderOfFunds(account: MerchantAccountRecord): Promise<string> {
  if (account.get("charge_processor_id") !== STRIPE_CHARGE_PROCESSOR_ID)
    throw new NotPortedError("MerchantAccount#holder_of_funds for a non-Stripe account", "app/models/merchant_account.rb:131");
  if (isStripeConnectAccountRecord(account)) return HOLDER_OF_FUNDS.CREATOR;
  if (await merchantAccountUser(account)) return HOLDER_OF_FUNDS.STRIPE;
  return HOLDER_OF_FUNDS.GUMROAD;
}
