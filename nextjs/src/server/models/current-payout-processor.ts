// Port of User#current_payout_processor (app/modules/user/payout_schedule.rb).
import { Prisma } from "@prisma/client";

import { nativePayoutsSupported } from "../page-props/signed-in/data.ts";
import { activeBankAccount, aliveComplianceInfo } from "../page-props/signed-in/reads.ts";

import { isBlank } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";
import { NotPortedError, type UserRecord } from "./user.ts";

export const PAYOUT_PROCESSORS = { PAYPAL: "PAYPAL", STRIPE: "STRIPE" } as const;
export type PayoutProcessor = (typeof PAYOUT_PROCESSORS)[keyof typeof PAYOUT_PROCESSORS];

// Without a payment_address, `paypal_payout_email` reads the connected PayPal account's details,
// which Rails may fetch from PayPal's API; any alive PayPal merchant account therefore stays with Rails.
export async function paypalPayoutEmailNeedsApi(user: UserRecord): Promise<boolean> {
  if (!isBlank(user.get("payment_address"))) return false;
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${user.get("id")} AND ${column("merchant_accounts", "deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_alive_at")} IS NOT NULL AND ${column("merchant_accounts", "charge_processor_deleted_at")} IS NULL AND ${column("merchant_accounts", "charge_processor_id")} = 'paypal' LIMIT 1`,
  );
  return rows.length > 0;
}

export const paypalPayoutEmailNotPorted = () =>
  new NotPortedError("User#paypal_payout_email", "app/models/user.rb:1668 (connected PayPal account details)");

export async function currentPayoutProcessor(user: UserRecord): Promise<PayoutProcessor> {
  if (await paypalPayoutEmailNeedsApi(user)) throw paypalPayoutEmailNotPorted();
  const userId = user.get("id") as bigint;
  // `(paypal_payout_email.present? && active_bank_account.blank?) || !native_payouts_supported?`
  if (!isBlank(user.get("payment_address")) && (await activeBankAccount(userId)) === null)
    return PAYOUT_PROCESSORS.PAYPAL;
  if (!nativePayoutsSupported(await aliveComplianceInfo(userId))) return PAYOUT_PROCESSORS.PAYPAL;
  return PAYOUT_PROCESSORS.STRIPE;
}
