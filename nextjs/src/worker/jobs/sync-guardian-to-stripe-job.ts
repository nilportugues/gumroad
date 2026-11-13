// Port of app/sidekiq/sync_guardian_to_stripe_job.rb up to the Stripe call. `User.find`, the payout gate's own predicate
// (StripePayoutProcessor.pays_user_via_stripe_connect?) and `user.stripe_account` run in Node and finish a seller paid through their own
// connected account or one with no Gumroad-managed account. Any other seller needs `Stripe::Account.retrieve` and
// StripeGuardianManager.sync, which hand back before the call.
// Golden: __fixtures__/sync-guardian-to-stripe-job.golden.json (scripts/golden/sync-guardian-to-stripe-job.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { stripeAccountOf } from "../../server/models/merchant-account.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { paysUserViaStripeConnect } from "../../server/models/stripe-payout-processor.ts";
import { findUserBang } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

export const syncGuardianToStripeJobWith = modelJob({ min: 1 }, async ([userId]) => {
  await beforeSideEffects(async () => {
    const user = await findUserBang(recordIdFrom(userId, "User.find"));
    if (await paysUserViaStripeConnect(user)) return;
    if ((await stripeAccountOf(user.get("id"))) === null) return;
    throw new HandBackToRuby("Stripe::Account.retrieve and StripeGuardianManager.sync");
  });
});
export const syncGuardianToStripeJob = syncGuardianToStripeJobWith();
