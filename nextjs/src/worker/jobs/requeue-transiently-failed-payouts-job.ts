// Port of app/sidekiq/requeue_transiently_failed_payouts_job.rb up to a transiently failed payout: the disabling feature and the
// payout period's failed Stripe payments. A run that finds none has nothing to count, report or requeue and returns without writing.
// A run that finds one groups the failures, reports the exhausted ones and requeues payouts, so it is handed back.
// Golden: __fixtures__/requeue-transiently-failed-payouts-job.golden.json (scripts/golden/requeue-transiently-failed-payouts-job.rb).
import { Prisma } from "@prisma/client";

import { parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { columnIn, selectRows } from "../../server/models/sql.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const DISABLE_FEATURE = "disable_transient_payout_failure_requeue";
const PAYOUT_DELAY_DAYS = 7;
const REQUEUEABLE_REASONS = ["processor_rate_limited", "processor_unavailable"];
const PERCENT = 100;
const FRIDAY = 5;
// Tuesday to Friday
const WEEKDAYS_BEFORE_THE_PAYOUT = [2, 3, 4, 5];
const MS_PER_DAY = 86_400_000;

export type FeatureRedis = { hgetall(key: string): Promise<Record<string, string>> };

// Feature.active?(:disable_transient_payout_failure_requeue) with no actor: the boolean gate, or a percentage of time that is always open.
async function requeueDisabled(redis: FeatureRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(DISABLE_FEATURE, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${DISABLE_FEATURE} uses an expression gate`);
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT)
    throw new HandBackToRuby(`${DISABLE_FEATURE} is enabled for a percentage of time`);
  return values.percentageOfTime >= PERCENT;
}

// User::PayoutSchedule.manual_payout_end_date. `Date.today` is the worker's local date, and the workers run in UTC.
function manualPayoutEndDate(now: Date): string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysToFriday = (FRIDAY - today.getUTCDay() + 7) % 7;
  const nextPayoutEnd = today.getTime() + (daysToFriday - PAYOUT_DELAY_DAYS) * MS_PER_DAY;
  const end = WEEKDAYS_BEFORE_THE_PAYOUT.includes(today.getUTCDay())
    ? nextPayoutEnd
    : nextPayoutEnd - PAYOUT_DELAY_DAYS * MS_PER_DAY;
  return new Date(end).toISOString().slice(0, 10);
}

export const requeueTransientlyFailedPayoutsJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: { redis?: () => FeatureRedis } = {},
) =>
  modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    const redis = (extras.redis ?? (() => getRedis("main") as unknown as FeatureRedis))();
    if (await requeueDisabled(redis)) return;

    const periodEnd = manualPayoutEndDate(deps.now());
    const failures = await selectRows(
      Prisma.sql`SELECT \`payments\`.* FROM \`payments\` WHERE \`payments\`.\`state\` = 'failed' AND \`payments\`.\`processor\` = 'STRIPE' AND ${columnIn("payments", "failure_reason", REQUEUEABLE_REASONS)} AND \`payments\`.\`payout_period_end_date\` = ${periodEnd}`,
    );
    if (failures.length > 0) throw new HandBackToRuby("a transiently failed payout is counted, reported and requeued");
  })(overrides);

export const requeueTransientlyFailedPayoutsJob = requeueTransientlyFailedPayoutsJobWith();
