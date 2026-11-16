// Port of app/sidekiq/create_stripe_merchant_account_worker.rb up to `StripeMerchantAccountManager.create_account`. `User.find` runs in
// Node (a missing user raises RecordNotFound, as in Ruby); creating the Stripe account hands back to Rails before anything is written
// or sent, as does an id Rails casts. Golden: __fixtures__/create-stripe-merchant-account-worker.golden.json
// (scripts/golden/create-stripe-merchant-account-worker.rb).
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const createStripeMerchantAccountWorkerWith = modelJob({ min: 1 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang<User>("User", id);

  throw new HandBackToRuby("the Stripe merchant account is created for the user");
});
export const createStripeMerchantAccountWorker = createStripeMerchantAccountWorkerWith();
