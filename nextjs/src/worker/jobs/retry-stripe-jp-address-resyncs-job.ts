// Port of app/sidekiq/retry_stripe_jp_address_resyncs_job.rb: every requested Japanese address field (kanji or kana) whose last resync
// is a week old, and that has not used its 8 attempts, queues RetryStripeJpAddressResyncForSellerJob once per seller. A request's
// json_data is read the way Rails reads it: ArgumentErrors (an unreadable time, json_data that is not a hash) count as due, while
// the TypeError/NoMethodError of an odd value propagate. Json Ruby's parser would reject, and a time shape whose Ruby error depends
// on which check trips first, hand the job back; the pushes of earlier batches are repeated by Ruby and dropped by the unique lock.
// Golden: __fixtures__/retry-stripe-jp-address-resyncs-job.golden.json (scripts/golden/retry-stripe-jp-address-resyncs-job.rb).
import { Prisma, type UserComplianceInfoRequest } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { toHash, jsonGet } from "../../server/models/concerns/json-data.ts";
import { RubyHash } from "../../server/models/concerns/psych.ts";
import { rubyToI } from "../../server/models/concerns/ruby-numeric.ts";
import { RubyArgumentError, timeIso8601 } from "../../server/models/concerns/ruby-time-parse.ts";
import { floatValue, isRubyFloat } from "../../server/models/concerns/ruby-values.ts";
import { rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import { NotPortedError } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const REQUESTS = "user_compliance_info_requests";
const FIELD_PREFIXES = ["individual.address_kanji.", "individual.address_kana."];
const MAX_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1_000;
const MIN_PORTED_YEAR = 1000n;
const RESYNC_JOB = "RetryStripeJpAddressResyncForSellerJob";

type Json = ReturnType<typeof rubyJsonParse>;

class RubyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

// The class name Ruby prints in "no implicit conversion of X into String".
function conversionName(value: Json): string {
  if (value === true || value === false) return String(value);
  if (typeof value === "number" || typeof value === "bigint")
    return Number.isInteger(value) || typeof value === "bigint" ? "Integer" : "Float";
  if (isRubyFloat(value)) return "Float";
  if (Array.isArray(value)) return "Array";
  return "Hash";
}

// `request.json_data`: a NULL or blank column is {}; anything but a Hash raises the ArgumentError due_for_retry? rescues.
function jsonDataOf(request: UserComplianceInfoRequest): RubyHash {
  const raw = request.json_data;
  if (raw === null || isBlank(raw)) return new RubyHash([]);
  let parsed: Json;
  try {
    parsed = rubyJsonParse(raw);
  } catch {
    // Ruby's JSON::ParserError is not rescued here; its message is not ported.
    throw new NotPortedError("JSON::ParserError", "json_data of a compliance request");
  }
  const hash = toHash(parsed);
  if (hash === null) throw new RubyArgumentError("json_data must be a hash");
  return hash;
}

// `RetryStripeJpAddressResyncsJob.attempts`: `json_data["address_resync_count"].to_i`
function attempts(hash: RubyHash): number | bigint {
  const count = jsonGet(hash, "address_resync_count");
  if (typeof count === "bigint") return count;
  if (isRubyFloat(count)) {
    const float = floatValue(count);
    if (!Number.isFinite(float))
      throw new NotPortedError("Float#to_i of a non-finite value", "retry_stripe_jp_address_resyncs_job.rb:21");
    return Math.trunc(float);
  }
  return rubyToI(count ?? null);
}

// `RetryStripeJpAddressResyncsJob.due_for_retry?`
export function dueForRetry(request: UserComplianceInfoRequest, now: Date): boolean {
  try {
    const hash = jsonDataOf(request);
    if (attempts(hash) >= MAX_ATTEMPTS) return false;

    const last = jsonGet(hash, "address_resync_at");
    if (isBlank(last) || (last instanceof RubyHash && last.entries.length === 0)) return true;
    if (typeof last !== "string")
      throw new RubyTypeError(`no implicit conversion of ${conversionName(last as Json)} into String`);
    let parsed;
    try {
      parsed = timeIso8601(last);
    } catch (error) {
      // A year before 1000 is either refused (counted as due) or long past (due): due either way. A later year is not ported.
      const year = /^[ \t\n\v\f\r]*(-?\d+)-/u.exec(last)?.[1];
      if (
        error instanceof Error &&
        error.name === "NotPortedError" &&
        year !== undefined &&
        BigInt(year) < MIN_PORTED_YEAR
      )
        return true;
      throw error;
    }
    // Time arithmetic keeps the microseconds the millisecond clock drops.
    const dueAt = BigInt(parsed.getTime() + RETRY_INTERVAL_MS) * 1000n + BigInt(parsed.microseconds % 1000);
    return dueAt <= BigInt(now.getTime()) * 1000n;
  } catch (error) {
    if (error instanceof RubyArgumentError) return true;
    throw error;
  }
}

export const retryStripeJpAddressResyncsJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const where = Prisma.sql`${column(REQUESTS, "state")} = ${"requested"} AND (field_needed LIKE ${`${FIELD_PREFIXES[0]}%`} OR field_needed LIKE ${`${FIELD_PREFIXES[1]}%`})`;
  await findInBatches<UserComplianceInfoRequest>(REQUESTS, where, BATCH_SIZE, async (batch) => {
    await deps.watchReplicaLag();
    // Every request is judged before the first push, so a failing one pushes nothing from its batch.
    const userIds = await beforeSideEffects(() => {
      // `filter_map { request.user_id if due?(request) }`: due? runs for a request without a user too.
      const due = batch.filter((request) => dueForRetry(request, deps.now()));
      return [...new Set(due.map((request) => request.user_id).filter((id) => id !== null))];
    });
    for (const userId of userIds) await performAsync(RESYNC_JOB, [userId]);
  });
});

export const retryStripeJpAddressResyncsJob = retryStripeJpAddressResyncsJobWith();
