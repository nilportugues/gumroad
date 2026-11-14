// Port of app/sidekiq/stripe_restraint_notice_email_job.rb up to `user.with_lock`. `User.find` runs in Node (a missing user raises
// RecordNotFound, as in Ruby); the locked transaction, the notice lookup, the mail and the admin comment hand back to Rails before
// BEGIN, as does an id Rails casts. Golden: __fixtures__/stripe-restraint-notice-email-job.golden.json
// (scripts/golden/stripe-restraint-notice-email-job.rb).
import type { User } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const stripeRestraintNoticeEmailJobWith = modelJob({ min: 4 }, async ([userId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(userId, "User.find"));
  await findByIdBang<User>("User", id);

  throw new HandBackToRuby("the notice is sent under the user's row lock");
});
export const stripeRestraintNoticeEmailJob = stripeRestraintNoticeEmailJobWith();
