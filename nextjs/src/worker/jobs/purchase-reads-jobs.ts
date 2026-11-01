// Ports of the jobs that only need to read purchases and subscriptions:
//   app/sidekiq/update_purchase_healthcheck_threshold_job.rb
//   app/sidekiq/find_expired_subscriptions_to_set_as_deactivated_worker.rb
//   app/sidekiq/send_rental_expires_soon_email_worker.rb
// and, handed back to Rails as soon as their read finds a row (the rest saves purchases or calls
// the charge processor, which Node does not do yet):
//   app/sidekiq/expire_rental_purchases_worker.rb
//   app/sidekiq/sync_stuck_purchases_job.rb
//   app/sidekiq/create_missing_purchase_events_worker.rb
// Golden: __fixtures__/purchase-reads-jobs.golden.json (scripts/golden/purchase-reads-jobs.rb).
import { Prisma, type Subscription } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { addDays, ago, dateToS, toCalendarDate } from "../../server/models/concerns/ruby-time.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import {
  countSuccessfulCreatedBetween,
  findPurchaseBang,
  inProgressCreatedBetween,
  isChargedbackNotReversedOrRefunded,
  purchaseIdFrom,
  rentalsToExpireFirstBatch,
  successfulWithoutEventsFirstBatch,
} from "../../server/models/purchase.ts";
import { castRow, findInBatches } from "../../server/models/sql.ts";
import { DEACTIVATION_COLUMNS, pastAndNotDeactivated, SUBSCRIPTIONS } from "../../server/models/subscription.ts";
import { findUrlRedirectForPurchase, isRental } from "../../server/models/url-redirect.ts";
import { NotPortedError } from "../../server/models/user.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { type JobDeps, modelJob } from "./support/job-deps.ts";

// RedisKey.min_successful_purchases_in_last_10_minutes
const THRESHOLD_KEY = "healthcheck:min_successful_purchases_in_last_10_minutes";
const BASELINE_DAYS = 7;
const BASELINE_FRACTION = 0.5;
const WINDOW = { minutes: 10 };
// Below this, half the median is so small that one quiet bucket could page; also the fallback when
// history is empty.
const MIN_THRESHOLD = 100;
const THRESHOLD_TTL_SECONDS = 3_600;

export type HealthcheckDeps = { redis: () => Redis };
const defaultHealthcheckDeps: HealthcheckDeps = { redis: () => getRedis("main") };

export const updatePurchaseHealthcheckThresholdJobWith = (overrides: Partial<JobDeps> = {}, healthcheck: Partial<HealthcheckDeps> = {}) => {
  const { redis } = { ...defaultHealthcheckDeps, ...healthcheck };
  return modelJob({ min: 0 }, async (_args, deps) => {
    const now = deps.now();
    const counts: number[] = [];
    for (let daysAgo = 1; daysAgo <= BASELINE_DAYS; daysAgo++) {
      const windowEnd = ago({ days: daysAgo }, now);
      counts.push(await countSuccessfulCreatedBetween({ begin: ago(WINDOW, windowEnd), end: windowEnd }));
    }
    const median = [...counts].sort((a, b) => a - b)[Math.floor(BASELINE_DAYS / 2)]!;
    // Ruby's Float#round rounds halves away from zero; the product is never negative.
    const threshold = Math.max(Math.round(median * BASELINE_FRACTION), MIN_THRESHOLD);
    await redis().set(THRESHOLD_KEY, String(threshold), "EX", THRESHOLD_TTL_SECONDS);
  })(overrides);
};

const SET_SUBSCRIPTION_AS_DEACTIVATED_WORKER = "SetSubscriptionAsDeactivatedWorker";

export const findExpiredSubscriptionsToSetAsDeactivatedWorkerWith = modelJob({ min: 0 }, async (_args, deps) => {
  const now = deps.now();
  // Three relations, built up front and run in order: cancelled, failed, then ended.
  for (const columnName of DEACTIVATION_COLUMNS) {
    await findInBatches<Pick<Subscription, "id">>(
      SUBSCRIPTIONS,
      pastAndNotDeactivated(columnName, now),
      1_000,
      async (rows) => {
        for (const row of rows) await performAsync(SET_SUBSCRIPTION_AS_DEACTIVATED_WORKER, [Number(castRow<Pick<Subscription, "id">>("Subscription", row).id)]);
      },
      Prisma.raw("`subscriptions`.`id`"),
    );
  }
});

export const sendRentalExpiresSoonEmailWorkerWith = modelJob({ min: 2 }, async (args, _deps, { runtime }) => {
  const [purchaseId, secondsTillExpiration] = args;
  await beforeSideEffects(() => {
    // The mail's arguments are serialised by ActiveJob; Node serialises integers and strings.
    if (!(typeof secondsTillExpiration === "string" || secondsTillExpiration === null || Number.isSafeInteger(secondsTillExpiration))) {
      throw new NotPortedError(`rental_expiring_soon(${JSON.stringify(secondsTillExpiration)})`, "send_rental_expires_soon_email_worker.rb:11");
    }
  });
  const purchase = await findPurchaseBang(await beforeSideEffects(() => purchaseIdFrom(purchaseId)));
  const urlRedirect = await findUrlRedirectForPurchase(purchase.id);
  if (urlRedirect === null) throw new TypeError("undefined method 'is_rental' for nil");
  if (!isRental(urlRedirect) || urlRedirect.rental_first_viewed_at != null || isChargedbackNotReversedOrRefunded(purchase)) return;

  const mailer = "CustomerLowPriorityMailer";
  const method = "rental_expiring_soon";
  await deliverLater(runtime, { mailer, method, args: [Number(purchase.id), secondsTillExpiration as number | string | null], queue: "low" }, mailRoute(mailer, method));
});

// Handing back after the first batch is safe: the read is all the job has done.
const handBackIfAny = (rows: readonly unknown[], why: string) => {
  if (rows.length > 0) throw new NotPortedError(why, "Purchase callbacks, charge processor");
};

export const expireRentalPurchasesWorkerWith = modelJob({ min: 0 }, async (_args, deps) => {
  const rows = await rentalsToExpireFirstBatch(deps.now());
  await beforeSideEffects(() => handBackIfAny(rows, "Purchase#save! for rental_expired"));
});

const STUCK_AFTER = { hours: 4 };
const STUCK_UNTIL = { days: 3 };

export const syncStuckPurchasesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const now = deps.now();
  const rows = await inProgressCreatedBetween({ begin: ago(STUCK_UNTIL, now), end: ago(STUCK_AFTER, now) });
  await beforeSideEffects(() => handBackIfAny(rows, "Purchase#sync_status_with_charge_processor"));
});

export const createMissingPurchaseEventsWorkerWith = modelJob({ min: 0, max: 1 }, async (args, deps) => {
  // An explicit date arrives as a JSON string, which Ruby cannot call #tomorrow on; run it in Ruby.
  await beforeSideEffects(() => {
    if (args.length > 0) throw new NotPortedError("CreateMissingPurchaseEventsWorker#perform(date)", "create_missing_purchase_events_worker.rb:7");
  });
  // Date.yesterday, in UTC.
  const today = toCalendarDate(deps.now());
  const yesterday = addDays(today, -1);
  const rows = await successfulWithoutEventsFirstBatch(dateToS(yesterday), dateToS(today));
  await beforeSideEffects(() => handBackIfAny(rows, "Event.create! for a purchase without events"));
});

export const updatePurchaseHealthcheckThresholdJob = updatePurchaseHealthcheckThresholdJobWith();
export const findExpiredSubscriptionsToSetAsDeactivatedWorker = findExpiredSubscriptionsToSetAsDeactivatedWorkerWith();
export const sendRentalExpiresSoonEmailWorker = sendRentalExpiresSoonEmailWorkerWith();
export const expireRentalPurchasesWorker = expireRentalPurchasesWorkerWith();
export const syncStuckPurchasesJob = syncStuckPurchasesJobWith();
export const createMissingPurchaseEventsWorker = createMissingPurchaseEventsWorkerWith();
