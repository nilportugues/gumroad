// Port of app/sidekiq/check_indian_card_mandate_registration_job.rb up to `Purchase#india_card_mandate_reliability_enabled?`. `Purchase.find`
// runs in Node and raises RecordNotFound for a missing purchase; everything after it hands back to Rails whole before any further read:
// the Flipper check on the seller, the order and merchant account behind it, the Stripe intent and the mandate writes and rechecks.
// An id Rails casts (a Float, a word) or raises on (nil) hands back before any statement.
// Golden: __fixtures__/check-indian-card-mandate-registration-job.golden.json
// (scripts/golden/check-indian-card-mandate-registration-job.rb).
import type { Purchase } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";

import { modelJob } from "./support/job-deps.ts";

export const checkIndianCardMandateRegistrationJobWith = modelJob({ min: 1, max: 2 }, async ([purchaseId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(purchaseId, "Purchase.find"));
  await findByIdBang<Purchase>("Purchase", id);

  throw new HandBackToRuby(
    "the mandate checks read the seller's feature flag, the order and the Stripe intent, then write",
  );
});
export const checkIndianCardMandateRegistrationJob = checkIndianCardMandateRegistrationJobWith();
