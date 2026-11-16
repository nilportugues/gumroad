// Port of app/sidekiq/collect_unclaimed_balances_of_inactive_stripe_accounts_job.rb up to the first account. The scan of old US Stripe
// merchant accounts that never collected runs in Node and finishes an empty one. An account in it needs the seller's last sale and payout,
// Stripe retrievals, a platform transfer and balance updates, so the whole sweep goes back to Rails before any of that.
// Golden: __fixtures__/collect-unclaimed-balances-of-inactive-stripe-accounts-job.golden.json
// (scripts/golden/collect-unclaimed-balances-of-inactive-stripe-accounts-job.rb).
import { Prisma, type MerchantAccount } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const MERCHANT_ACCOUNTS = "merchant_accounts";
const FIND_EACH_BATCH_SIZE = 1_000;
// STRIPE_ACCOUNT_INACTIVE_AFTER_DURATION
const INACTIVE_AFTER_YEARS = 3;

export const collectUnclaimedBalancesOfInactiveStripeAccountsJobWith = modelJob(
  { min: 0, max: 0 },
  async (_args, deps) => {
    const cutoff = ago({ years: INACTIVE_AFTER_YEARS }, deps.now());
    // `MerchantAccount.stripe.where(country: "US").where.not(charge_processor_merchant_id: nil).where.not("json_data LIKE '%stripe_connect%'")
    //   .where("json_data->>'$.unclaimed_balance_collection_transfer_id' IS NULL").where("created_at < ?", cutoff).find_each`
    await findInBatches<MerchantAccount>(
      MERCHANT_ACCOUNTS,
      Prisma.sql`${column(MERCHANT_ACCOUNTS, "charge_processor_id")} = 'stripe' AND ${column(MERCHANT_ACCOUNTS, "country")} = 'US' AND ${column(MERCHANT_ACCOUNTS, "charge_processor_merchant_id")} IS NOT NULL AND NOT (json_data LIKE '%stripe_connect%') AND (json_data->>'$.unclaimed_balance_collection_transfer_id' IS NULL) AND (created_at < ${cutoff})`,
      FIND_EACH_BATCH_SIZE,
      () => {
        throw new HandBackToRuby("a merchant account whose Stripe balance may be collected");
      },
    );
  },
);
export const collectUnclaimedBalancesOfInactiveStripeAccountsJob =
  collectUnclaimedBalancesOfInactiveStripeAccountsJobWith();
