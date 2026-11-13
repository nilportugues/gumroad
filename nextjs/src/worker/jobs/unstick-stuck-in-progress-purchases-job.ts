// Port of app/sidekiq/unstick_stuck_in_progress_purchases_job.rb (Purchase::UnstickStuckInProgressService.process(dry_run: false)) up to
// its first purchase to recover. The candidate scan and the aging-out count and id read run in Node and finish a run with nothing
// stuck. A candidate means the charge processor (SyncStatusWithChargeProcessorService) and a row lock, and an aging-out id means a
// Sentry report; both hand the job back to Rails after the same statements and before any write.
// Golden: __fixtures__/unstick-stuck-in-progress-purchases-job.golden.json (scripts/golden/unstick-stuck-in-progress-purchases-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago as agoExact, truncateToSeconds } from "../../server/models/concerns/ruby-time.ts";
import { PURCHASES } from "../../server/models/purchase.ts";
import { column, findInBatches, inList, selectRows, table } from "../../server/models/sql.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const BATCH_SIZE = 100;
const MIN_AGE_DAYS = 3;
const MAX_AGE_DAYS = 90;
const REPORT_AGING_OUT_GRACE_DAYS = 7;
const AGING_OUT_LIMIT = 500;

// `created_at` has second precision, which Rails' type cast applies to the bound.
const ago = (days: number, now: Date) => truncateToSeconds(agoExact({ days }, now));

const purchases = (name: string) => column(PURCHASES, name);
const IN_PROGRESS = Prisma.sql`${purchases("purchase_state")} = 'in_progress'`;

// Ids Rails casts to an Integer; anything else (nil, a word, a float, nested arrays) is not ported.
function explicitIds(value: unknown): bigint[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new HandBackToRuby("purchase ids that are not a list");
  return value.map((id) => {
    if (typeof id === "number" && Number.isSafeInteger(id)) return BigInt(id);
    throw new HandBackToRuby("a purchase id that is not an Integer");
  });
}

export async function unstickStuckInProgressPurchases(args: unknown[], deps: JobDeps): Promise<void> {
  const ids = explicitIds(args[0]);
  const now = deps.now();

  // A supplied id list is the complete manual scope and bypasses the age bounds. An empty one is a null relation: no statement.
  if (ids?.length === 0) return;
  const candidates =
    ids === null
      ? Prisma.sql`${IN_PROGRESS} AND ${purchases("created_at")} BETWEEN ${ago(MAX_AGE_DAYS, now)} AND ${ago(MIN_AGE_DAYS, now)}`
      : ids.length === 1
        ? Prisma.sql`${IN_PROGRESS} AND ${purchases("id")} = ${ids[0]}`
        : Prisma.sql`${IN_PROGRESS} AND ${purchases("id")} IN ${inList(ids)}`;
  await findInBatches(PURCHASES, candidates, BATCH_SIZE, () => {
    throw new HandBackToRuby("a purchase to recover (SyncStatusWithChargeProcessorService)");
  });
  if (ids !== null) return;

  const agingOut = Prisma.sql`${IN_PROGRESS} AND ${purchases("created_at")} BETWEEN ${ago(MAX_AGE_DAYS + REPORT_AGING_OUT_GRACE_DAYS, now)} AND ${ago(MAX_AGE_DAYS, now)} AND ${purchases("charge_processor_id")} IS NOT NULL AND (purchases.price_cents != 0)`;
  await selectRows(Prisma.sql`SELECT COUNT(*) FROM ${table(PURCHASES)} WHERE ${agingOut}`);
  const aged = await selectRows(
    Prisma.sql`SELECT ${purchases("id")} FROM ${table(PURCHASES)} WHERE ${agingOut} LIMIT ${Prisma.raw(String(AGING_OUT_LIMIT))}`,
  );
  if (aged.length > 0) throw new HandBackToRuby("purchases aged out of the recovery window (ErrorNotifier)");
}

export const unstickStuckInProgressPurchasesJobWith = modelJob({ min: 0, max: 1 }, async (args, deps) => {
  await unstickStuckInProgressPurchases(args, deps);
});
export const unstickStuckInProgressPurchasesJob = unstickStuckInProgressPurchasesJobWith();
