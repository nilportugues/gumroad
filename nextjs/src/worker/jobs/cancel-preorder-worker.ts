// Port of the guard of app/sidekiq/cancel_preorder_worker.rb: a preorder that is not `authorization_successful` is left alone, and a
// missing one fails with Ruby's NoMethodError on nil. An authorized preorder is cancelled through the state machine (the seller and
// purchase checks, the transition callbacks and the cancellation emails), which stays with Rails: the job is handed back as soon as
// the preorder is read, before anything is written. An id Rails casts (a Float, a word) hands back before any statement.
// Golden: __fixtures__/cancel-preorder-worker.golden.json (scripts/golden/cancel-preorder-worker.rb).
import { type Preorder } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";

import { RubyNoMethodError } from "./calculate-sale-numbers-worker.ts";
import { modelJob } from "./support/job-deps.ts";

export const cancelPreorderWorkerWith = modelJob({ min: 1 }, async ([preorderId]) => {
  // `find_by(id: nil)` still asks the database.
  const id = await beforeSideEffects(() => (preorderId === null ? null : recordIdFrom(preorderId, "Preorder.find_by")));
  const preorder = await findOneBy<Preorder>("Preorder", "id", id, true);
  if (preorder === null) throw new RubyNoMethodError("undefined method 'is_authorization_successful?' for nil");
  if (preorder.state !== "authorization_successful") return;

  throw new HandBackToRuby("Preorder#mark_cancelled! is not ported");
});

export const cancelPreorderWorker = cancelPreorderWorkerWith();
