// Port of app/sidekiq/charge_preorder_worker.rb up to `Preorder#charge!`. `Preorder.find_by(id:)` runs in Node; a missing preorder
// raises Ruby's NoMethodError on nil (`charge!` is called without a guard). A preorder means the card charge and everything after it,
// which hand back to Rails before any write, as does an id Rails casts. Golden: __fixtures__/charge-preorder-worker.golden.json
// (scripts/golden/charge-preorder-worker.rb).
import type { Preorder } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { NoMethodError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

export const chargePreorderWorkerWith = modelJob({ min: 1, max: 2 }, async ([preorderId]) => {
  const id = await beforeSideEffects(() => recordIdFrom(preorderId, "Preorder.find_by"));
  const preorder = await findById<Preorder>("Preorder", id);
  if (preorder === null) throw new NoMethodError("undefined method 'charge!' for nil");

  throw new HandBackToRuby("a preorder is charged");
});
export const chargePreorderWorker = chargePreorderWorkerWith();
