// Port of app/sidekiq/refresh_high_volume_seller_fee_eligibility_job.rb. The nightly sweep (no seller id) runs in Node: the sellers
// whose paid sales this month reach the threshold, plus every seller already flagged, each re-enqueued as a per-seller job. A seller
// id that matches no user finishes after one read; one that matches a user is handed back before any write, because
// User#refresh_high_volume_fee_eligibility! saves the user with its callbacks, which are not ported.
// Golden: __fixtures__/refresh-high-volume-seller-fee-eligibility-job.golden.json
// (scripts/golden/refresh-high-volume-seller-fee-eligibility-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { findById, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PURCHASES = "purchases";
const USERS = "users";
const JOB = "RefreshHighVolumeSellerFeeEligibilityJob";
// User::HIGH_VOLUME_FEE_THRESHOLD_CENTS; Rails sends it quoted in the HAVING clause.
const HIGH_VOLUME_FEE_THRESHOLD_CENTS = "2000000";

// `seller_id.blank?` for the shapes a job argument can take. A string of other Unicode whitespace, or any other value, reads as
// present here and is handed back by recordIdFrom, which only takes an Integer or its digits.
function isBlank(arg: JsonValue | undefined): boolean {
  if (arg === undefined || arg === null || arg === false) return true;
  if (typeof arg === "string") return /^[ \t\n\v\f\r]*$/u.test(arg);
  if (Array.isArray(arg)) return arg.length === 0;
  return typeof arg === "object" && Object.getPrototypeOf(arg) === Object.prototype && Object.keys(arg).length === 0;
}

const beginningOfMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const jobArg = (id: bigint | number | null): JsonValue =>
  typeof id === "bigint" && id <= BigInt(Number.MAX_SAFE_INTEGER) && id >= -BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(id)
    : id;

export const refreshHighVolumeSellerFeeEligibilityJobWith = modelJob({ min: 0, max: 1 }, async ([sellerId], deps) => {
  if (!isBlank(sellerId)) {
    const id = await beforeSideEffects(() => recordIdFrom(sellerId, "User.find_by"));
    if ((await findById("User", id)) === null) return;
    throw new HandBackToRuby("User#refresh_high_volume_fee_eligibility! saves the user with its callbacks");
  }

  // The paid scope, where and having are string fragments in Rails: sent unquoted, as written.
  const qualifying = await selectRows<{ seller_id: bigint | number | null }>(
    Prisma.sql`SELECT ${column(PURCHASES, "seller_id")} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "purchase_state")} = 'successful' AND (purchases.price_cents > 0) AND (stripe_refunded is null OR stripe_refunded = 0) AND (purchases.created_at >= ${beginningOfMonth(deps.now())}) GROUP BY ${column(PURCHASES, "seller_id")} HAVING (SUM(purchases.price_cents) >= ${HIGH_VOLUME_FEE_THRESHOLD_CENTS})`,
  );
  const flagged = await selectRows<{ id: bigint | number }>(
    Prisma.sql`SELECT ${column(USERS, "id")} FROM ${table(USERS)} WHERE (json_data LIKE '%high_volume_fee_month%')`,
  );

  const ids = [...qualifying.map((row) => row.seller_id), ...flagged.map((row) => row.id)].map(jobArg);
  const seen = new Set<JsonValue>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    await performAsync(JOB, [id]);
  }
});

export const refreshHighVolumeSellerFeeEligibilityJob = refreshHighVolumeSellerFeeEligibilityJobWith();
