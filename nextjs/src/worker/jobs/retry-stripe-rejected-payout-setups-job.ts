// Port of app/sidekiq/retry_stripe_rejected_payout_setups_job.rb: every live payout note the admin left on a seller for a rejected
// Stripe setup that is due for another try (three days after the last, or already past the retry limit so it can be abandoned)
// queues RetryStripeRejectedPayoutSetupForSellerJob once per seller, then RetryStripeJpAddressResyncsJob runs inline.
// A note's json_data that Ruby would not parse (or a boolean or float one), and a retry time that is neither blank nor a string, hand the
// job back; the pushes of earlier batches are repeated by Ruby and dropped by the unique lock.
// Golden: __fixtures__/retry-stripe-rejected-payout-setups-job.golden.json (scripts/golden/retry-stripe-rejected-payout-setups-job.rb).
import { Prisma, type Comment } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { COMMENT_TYPES, COMMENTS } from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { jsonGet, toHash } from "../../server/models/concerns/json-data.ts";
import { RubyHash } from "../../server/models/concerns/psych.ts";
import { rubyToI } from "../../server/models/concerns/ruby-numeric.ts";
import { RubyArgumentError, timeIso8601 } from "../../server/models/concerns/ruby-time-parse.ts";
import { floatValue, isRubyFloat } from "../../server/models/concerns/ruby-values.ts";
import { rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { gumroadAdminId } from "../../server/models/gumroad-admin-id.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { retryStripeJpAddressResyncsJobWith } from "./retry-stripe-jp-address-resyncs-job.ts";
import { modelJob } from "./support/job-deps.ts";

// StripeMerchantAccountManager::{BANK_SYNC,POSTAL_CODE,NO_VERDICT}_FAILURE_NOTE_PREFIX
export const FAILURE_NOTE_PREFIXES = [
  "Stripe bank sync failed",
  "Stripe postal code rejected",
  "Stripe payout setup failed without a verdict",
];
const RETRY_WINDOW_WEEKS = 8;
const MAX_RETRIES = RETRY_WINDOW_WEEKS;
const RETRY_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1_000;
const SELLER_JOB = "RetryStripeRejectedPayoutSetupForSellerJob";

export type Json = ReturnType<typeof rubyJsonParse>;

// `note.json_data`: a NULL or blank column is {}; anything but a Hash raises in Ruby.
function jsonDataOf(note: Comment): RubyHash {
  const raw = note.json_data;
  if (raw === null || isBlank(raw)) return new RubyHash([]);
  let parsed: Json;
  try {
    parsed = rubyJsonParse(raw);
  } catch {
    throw new NotPortedError("JSON::ParserError", "json_data of a payout note");
  }
  const hash = toHash(parsed);
  if (hash !== null) return hash;
  // Recorded: Ruby reads null, an array, a string and an integer as an empty hash. The other scalars are not recorded.
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed === "string" ||
    typeof parsed === "bigint" ||
    typeof parsed === "number"
  )
    return new RubyHash([]);
  throw new NotPortedError("json_data of a payout note that is a boolean or a float", "json_data.rb");
}

export const isBlankJson = (value: unknown) => isBlank(value) || (value instanceof RubyHash && value.entries.length === 0);

// `note.json_data["retry_count"].to_i`
function retryCount(hash: RubyHash): number | bigint {
  const count = jsonGet(hash, "retry_count");
  if (typeof count === "bigint") return count;
  if (isRubyFloat(count)) {
    const float = floatValue(count);
    if (!Number.isFinite(float))
      throw new NotPortedError(
        "Float#to_i of a non-finite value",
        "retry_stripe_rejected_payout_setups_job.rb:retry_count",
      );
    return Math.trunc(float);
  }
  return rubyToI(count ?? null);
}

// `RetryStripeRejectedPayoutSetupsJob.due_for_processing?`
export function dueForProcessing(note: Comment, now: Date): boolean {
  const hash = jsonDataOf(note);
  if (!isBlankJson(jsonGet(hash, "abandoned_at"))) return false;
  if (retryCount(hash) >= MAX_RETRIES) return true;

  const last = jsonGet(hash, "last_retried_at");
  if (isBlankJson(last)) return true;
  if (typeof last !== "string")
    throw new NotPortedError(
      "Time.iso8601 of a value that is not a string",
      "retry_stripe_rejected_payout_setups_job.rb:due_for_processing?",
    );
  let parsed;
  try {
    parsed = timeIso8601(last);
  } catch (error) {
    if (error instanceof RubyArgumentError) return true;
    throw error;
  }
  // Time arithmetic keeps the microseconds the millisecond clock drops.
  const dueAt = BigInt(parsed.getTime() + RETRY_INTERVAL_MS) * 1000n + BigInt(parsed.microseconds % 1000);
  return dueAt <= BigInt(now.getTime()) * 1000n;
}

export const retryStripeRejectedPayoutSetupsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps, context) => {
  const c = (name: string) => column(COMMENTS, name);
  const likes = FAILURE_NOTE_PREFIXES.map((prefix) => Prisma.sql`content LIKE ${`${prefix}%`}`);
  const where = Prisma.sql`${c("deleted_at")} IS NULL AND ${c("comment_type")} = ${COMMENT_TYPES.PAYOUT_NOTE} AND ${c("commentable_type")} = ${"User"} AND ${c("author_id")} = ${gumroadAdminId()} AND (${Prisma.join(likes, " OR ")})`;
  await findInBatches<Comment>(COMMENTS, where, BATCH_SIZE, async (batch) => {
    await deps.watchReplicaLag();
    // Every note is judged before the first push, so a failing one pushes nothing from its batch.
    const userIds = await beforeSideEffects(() => {
      const due = batch.filter((note) => dueForProcessing(note, deps.now()));
      return [...new Set(due.map((note) => note.commentable_id))];
    });
    for (const userId of userIds) await performAsync(SELLER_JOB, [Number(userId)]);
  });
  await retryStripeJpAddressResyncsJobWith(deps)([], context);
});

export const retryStripeRejectedPayoutSetupsJob = retryStripeRejectedPayoutSetupsJobWith();
