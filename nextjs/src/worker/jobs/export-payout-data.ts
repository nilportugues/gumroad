// Port of app/sidekiq/export_payout_data.rb up to the CSV. `Payment.where(id: ...).find_each` runs in Node and a job that finds no
// payment finishes there (Rails sends no statement for an empty list). A payment that is found goes back to Rails whole: what follows
// builds the CSV (Exports::Payouts::Csv walks balances, PayPal and Stripe Connect sales), zips it and delivers the mail with the file
// attached, and the same-seller return comes only after the CSV is built. An id Rails casts (a word becomes NULL) goes back before any read.
// Golden: __fixtures__/export-payout-data.golden.json (scripts/golden/export-payout-data.rb).
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { columnIn, findInBatches } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FIND_EACH_BATCH_SIZE = 1000;

// `Array.wrap`
const wrap = (value: JsonValue): JsonValue[] => (value === null ? [] : Array.isArray(value) ? value : [value]);

export const exportPayoutDataWith = modelJob({ min: 2 }, async ([paymentIds]) => {
  const ids = await beforeSideEffects(() =>
    wrap(paymentIds as JsonValue).map((id) => recordIdFrom(id, "Payment.where(id:)")),
  );
  if (ids.length === 0) return;

  await findInBatches("payments", columnIn("payments", "id", ids), FIND_EACH_BATCH_SIZE, () => {
    throw new HandBackToRuby("the payouts are exported to CSV and mailed with the file attached");
  });
});
export const exportPayoutData = exportPayoutDataWith();
