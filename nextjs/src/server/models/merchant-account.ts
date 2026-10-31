// The parts of app/models/merchant_account.rb (and User#stripe_account) the ported jobs read. No
// writes: MerchantAccount's save callbacks are not ported.
import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "./sql.ts";

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
