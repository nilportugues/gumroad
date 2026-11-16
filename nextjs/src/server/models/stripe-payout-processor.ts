// StripePayoutProcessor.pays_user_via_stripe_connect? (app/business/payments/payouts/processor/stripe/stripe_payout_processor.rb).
import { merchantMigrationEnabled, stripeConnectAccountOf } from "./stripe-merchant-account-disconnect.ts";
import type { UserRecord } from "./user.ts";

// A connected account that is not Brazilian: `user.has_stripe_account_connected? && !user.stripe_connect_account.is_a_brazilian_...?`.
export async function paysUserViaStripeConnect(user: UserRecord): Promise<boolean> {
  if (!(await merchantMigrationEnabled(user))) return false;
  const connect = await stripeConnectAccountOf(user.get("id"));
  if (connect === null) return false;
  return connect.country !== "BR";
}
