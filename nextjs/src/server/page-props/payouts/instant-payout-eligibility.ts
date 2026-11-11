// The database half of User#eligible_for_instant_payouts? (app/models/user.rb): the seasoning of the payout
// destination account. Whether an eligible seller's bank account supports instant payouts is a Stripe call
// (BankAccount#supports_instant_payouts?) unless the bank account carries no Stripe ids, which the Payouts page checks.
import { Prisma } from "@prisma/client";

import { ago } from "../../models/concerns/ruby-time.ts";
import { type MerchantAccountRow, isStripeConnectAccount } from "../../models/merchant-account.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { jsonAttr } from "../../models/user-compliance-info.ts";

// User::MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS
export const MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS = { days: 60 } as const;

export type SeasoningRow = MerchantAccountRow & {
  created_at: Date;
  charge_processor_alive_at: Date | null;
  charge_processor_deleted_at: Date | null;
};

const stripeRejected = (account: MerchantAccountRow) =>
  String(jsonAttr({ json_data: account.json_data as string | null }, "stripe_disabled_reason") ?? "").startsWith(
    "rejected.",
  );

// User#seasoned_for_instant_payouts?(account). `stripeAccounts` is `user.merchant_accounts.stripe`, retired rows included.
export function seasonedForInstantPayouts(account: SeasoningRow, stripeAccounts: SeasoningRow[], now: Date): boolean {
  const cutoff = ago(MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS, now);
  if (account.created_at.getTime() <= cutoff.getTime()) return true;

  return stripeAccounts.some(
    (predecessor) =>
      predecessor.created_at.getTime() <= cutoff.getTime() &&
      isStripeConnectAccount(predecessor) === isStripeConnectAccount(account) &&
      !stripeRejected(predecessor) &&
      // charge_processor_deleted? || charge_processor_alive?
      (predecessor.charge_processor_deleted_at !== null || predecessor.charge_processor_alive_at !== null),
  );
}

const stripeAccountsOf = (userId: bigint) =>
  selectRows<SeasoningRow>(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId} AND ${column("merchant_accounts", "charge_processor_id")} = 'stripe'`,
  );

// `StripePayoutProcessor.destination_merchant_account(user, [])`, the destination while Stripe holds none of the seller's
// payable balances, then User#stripe_accounts_seasoned_for_instant_payouts?: it must exist, be active (the alive
// accounts passed in are) and be seasoned. `connect` and `standard` are the seller's alive Stripe Connect and
// Gumroad-managed accounts; the Connect one wins when the seller routes through Stripe Connect. Sellers whose balances
// Stripe holds have a second candidate destination and are the caller's to hand back.
export async function emptyBalanceDestinationSeasoned(
  userId: bigint,
  destinations: {
    connectRoutingActive: boolean;
    connect: MerchantAccountRow | null;
    standard: MerchantAccountRow | null;
  },
  now: Date,
): Promise<boolean> {
  const destination = (
    destinations.connectRoutingActive ? destinations.connect : destinations.standard
  ) as SeasoningRow | null;
  if (destination === null) return false;
  return seasonedForInstantPayouts(destination, await stripeAccountsOf(userId), now);
}
