// Port of app/sidekiq/retry_failed_paypal_payouts_worker.rb up to the retry: the :disable_transient_payout_failure_requeue switch
// (asked with no actor), the payout end date of the day (the next Friday's cycle less a week, less another outside Tuesday to Friday)
// and the one read of sellers with a failed PayPal payout that is unfinished or hit a processor outage. The usual run finds none and
// ends there. A run that finds sellers hands back whole: `Payouts.create_payments_for_balances_up_to_date_for_users` creates the
// payments and pushes the PayPal batch, and nothing has been written by then. A switch on a percentage of time (Flipper rolls per call)
// or an expression gate hands back before any read.
// Golden: __fixtures__/retry-failed-paypal-payouts-worker.golden.json (scripts/golden/retry-failed-paypal-payouts-worker.rb).
import { Prisma } from "@prisma/client";

import { evaluateFeature, parseGateValues, readFeatureDoc } from "../../server/infra/flipper.ts";
import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { selectRows } from "../../server/models/sql.ts";
import { addDays, dateOnly, isoDate, PAYOUT_DELAY_DAYS } from "../../server/page-props/payouts/payout-schedule.ts";

import { modelJob } from "./support/job-deps.ts";

const DISABLE_FEATURE = "disable_transient_payout_failure_requeue";
const PERCENT = 100;
const FRIDAY = 5;
const TUESDAY = 2;
const PAYPAL = "PAYPAL";
const PROCESSOR_UNAVAILABLE = "processor_unavailable";

export type FeatureRedis = { hgetall(key: string): Promise<Record<string, string>> };

// Feature.active?(name) with no actor.
async function featureActive(name: string, redis: FeatureRedis): Promise<boolean> {
  const values = parseGateValues(await readFeatureDoc(name, redis as never));
  if (values.boolean) return true;
  if (values.expression !== undefined && values.expression !== null)
    throw new HandBackToRuby(`${name} uses an expression gate`);
  if (values.percentageOfTime > 0 && values.percentageOfTime < PERCENT)
    throw new HandBackToRuby(`${name} is enabled for a percentage of time`);
  return evaluateFeature(name, values);
}

// User::PayoutSchedule.manual_payout_end_date, with Date.today in UTC.
export function manualPayoutEndDate(now: Date): Date {
  const today = dateOnly(now);
  const nextScheduledPayoutDate = addDays(today, (FRIDAY - today.getUTCDay() + 7) % 7);
  const nextScheduledPayoutEndDate = addDays(nextScheduledPayoutDate, -PAYOUT_DELAY_DAYS);
  const weekday = today.getUTCDay();
  return weekday >= TUESDAY && weekday <= FRIDAY
    ? nextScheduledPayoutEndDate
    : addDays(nextScheduledPayoutEndDate, -PAYOUT_DELAY_DAYS);
}

export const retryFailedPaypalPayoutsWorkerWith = (extras: { redis?: () => FeatureRedis } = {}) =>
  modelJob({ min: 0, max: 0 }, async (_args, deps) => {
    const redis = (extras.redis ?? (() => getRedis("main") as unknown as FeatureRedis))();
    if (await featureActive(DISABLE_FEATURE, redis)) return;

    const payoutPeriodEndDate = isoDate(manualPayoutEndDate(deps.now()));
    const sellers = await selectRows(
      Prisma.sql`SELECT \`users\`.* FROM \`users\` INNER JOIN \`payments\` ON \`payments\`.\`user_id\` = \`users\`.\`id\` WHERE \`payments\`.\`state\` = ${"failed"} AND \`payments\`.\`processor\` = ${PAYPAL} AND \`payments\`.\`payout_period_end_date\` = ${payoutPeriodEndDate} AND (payments.failure_reason IS NULL OR payments.failure_reason = ${PROCESSOR_UNAVAILABLE})`,
    );
    if (sellers.length === 0) return;

    throw new HandBackToRuby(
      "Payouts.create_payments_for_balances_up_to_date_for_users creates the retried PayPal payouts",
    );
  });
export const retryFailedPaypalPayoutsWorker = retryFailedPaypalPayoutsWorkerWith()();
