// Port of app/sidekiq/retry_stripe_rejected_payout_setups_job.rb: the payout notes the Stripe merchant account manager leaves when a
// payout setup was rejected (bank sync, postal code, no verdict) queue RetryStripeRejectedPayoutSetupForSellerJob once per seller
// when due, then the Japanese address resync sweep runs. A note's json_data is read the way Rails reads it: an ArgumentError
// (json_data that is not a hash, an unreadable time) counts as due, while the TypeError/NoMethodError of an odd count propagates.
// Golden: __fixtures__/retry-stripe-rejected-payout-setups-job.golden.json (scripts/golden/retry-stripe-rejected-payout-setups-job.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { COMMENT_TYPES } from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { jsonGet } from "../../server/models/concerns/json-data.ts";
import { RubyHash } from "../../server/models/concerns/psych.ts";
import { RubyArgumentError } from "../../server/models/concerns/ruby-time-parse.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import PAYMENTS_DATA from "../../server/page-props/settings/payments-data.generated.json" with { type: "json" };

import {
  attempts,
  jsonDataOf,
  retryIntervalElapsed,
  retryStripeJpAddressResyncsJobWith,
} from "./retry-stripe-jp-address-resyncs-job.ts";
import { modelJob } from "./support/job-deps.ts";

const COMMENTS = "comments";
const SELLER_JOB = "RetryStripeRejectedPayoutSetupForSellerJob";
const RETRY_WINDOW_WEEKS = 8;
const MAX_RETRIES = RETRY_WINDOW_WEEKS;
const RETRY_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1_000;
// StripeMerchantAccountManager::{BANK_SYNC,POSTAL_CODE,NO_VERDICT}_FAILURE_NOTE_PREFIX
const NOTE_PREFIXES = [
  "Stripe bank sync failed",
  "Stripe postal code rejected",
  "Stripe payout setup failed without a verdict",
];

type Note = { id: bigint; commentable_id: bigint | null; json_data: string | null };

const present = (value: unknown) => !(isBlank(value) || (value instanceof RubyHash && value.entries.length === 0));

// `RetryStripeRejectedPayoutSetupsJob.due_for_processing?`
export function dueForProcessing(note: Pick<Note, "json_data">, now: Date): boolean {
  try {
    const hash = jsonDataOf(note);
    if (present(jsonGet(hash, "abandoned_at"))) return false;
    if (attempts(hash, "retry_count") >= MAX_RETRIES) return true;
    return retryIntervalElapsed(jsonGet(hash, "last_retried_at"), RETRY_INTERVAL_MS, now);
  } catch (error) {
    if (error instanceof RubyArgumentError) return true;
    throw error;
  }
}

export const retryStripeRejectedPayoutSetupsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps, context) => {
  const where = Prisma.sql`${column(COMMENTS, "deleted_at")} IS NULL AND ${column(COMMENTS, "comment_type")} = ${COMMENT_TYPES.PAYOUT_NOTE} AND ${column(COMMENTS, "commentable_type")} = ${"User"} AND ${column(COMMENTS, "author_id")} = ${PAYMENTS_DATA.constants.gumroadAdminId} AND (content LIKE ${`${NOTE_PREFIXES[0]}%`} OR content LIKE ${`${NOTE_PREFIXES[1]}%`} OR content LIKE ${`${NOTE_PREFIXES[2]}%`})`;
  await findInBatches<Note>(COMMENTS, where, BATCH_SIZE, async (batch) => {
    await deps.watchReplicaLag();
    // Every note is judged before the first push, so a failing one pushes nothing from its batch.
    const userIds = await beforeSideEffects(() => {
      const due = batch.filter((note) => dueForProcessing(note, deps.now()));
      return [...new Set(due.map((note) => note.commentable_id).filter((id) => id !== null))];
    });
    for (const userId of userIds) await performAsync(SELLER_JOB, [userId]);
  });
  await retryStripeJpAddressResyncsJobWith(deps)([], context);
});

export const retryStripeRejectedPayoutSetupsJob = retryStripeRejectedPayoutSetupsJobWith();
