// Port of app/sidekiq/backfill_membership_renewal_reminders_job.rb and Onetime::BackfillMembershipRenewalReminders.process (the real
// run, not the dry run): a Redis claim and cursor around a find_each over live subscriptions, each eligible one scheduling its
// RecurringChargeReminderWorker. A row that raises a Ruby StandardError is counted and skipped; any other failure leaves the job to
// Ruby, which resumes after the cursor Node last advanced (the claim is released first).
// Golden: __fixtures__/backfill-membership-renewal-reminders-job.golden.json (scripts/golden/backfill-membership-renewal-reminders-job.rb).
import { Prisma, type Subscription } from "@prisma/client";
import type { Redis } from "ioredis";

import { getRedis } from "../../server/infra/redis.ts";
import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { rubyToI } from "../../server/models/concerns/ruby-numeric.ts";
import { advance } from "../../server/models/concerns/ruby-time.ts";
import { column, findInBatches } from "../../server/models/sql.ts";
import {
  defaultSubscriptionDeps,
  renewalReminderEmailDays,
  SubscriptionRecord,
  SUBSCRIPTIONS,
  type SubscriptionDeps,
} from "../../server/models/subscription.ts";

import { modelJob, type JobDeps } from "./support/job-deps.ts";

const BATCH_SIZE = 500;
const CURSOR_KEY = "onetime:backfill_membership_renewal_reminders:cursor";
const RUNNING_KEY = "onetime:backfill_membership_renewal_reminders:running";
const RUNNING_TTL_SECONDS = 2 * 60;
const FLAG_ENABLED_AT = new Date(Date.UTC(2026, 8, 26, 15, 0, 24));
const DUE_NOW_SPREAD_SECONDS = 60 * 60;
const REMINDER_JOB = "RecurringChargeReminderWorker";

export type BackfillDeps = {
  redis: () => Pick<Redis, "set" | "get" | "del" | "multi">;
  // Kernel#rand
  random: () => number;
  featureActive: SubscriptionDeps["featureActive"];
};

const defaultBackfillDeps: BackfillDeps = {
  redis: () => getRedis("main"),
  random: () => Math.random(),
  featureActive: defaultSubscriptionDeps.featureActive,
};

// A Ruby NoMethodError or TypeError raised inside the row's `begin ... rescue => e`; anything else is not a case Node knows.
const isRubyStandardError = (error: unknown) => error instanceof TypeError;

async function eligible(subscription: SubscriptionRecord): Promise<boolean> {
  if (!(await subscription.sendRenewalReminders())) return false;
  const lastPurchaseAt = await subscription.lastPurchaseAt();
  if (lastPurchaseAt === null) return false;
  if (!(lastPurchaseAt.getTime() < FLAG_ENABLED_AT.getTime())) return false;
  if (!subscription.alive(false)) return false;
  if (subscription.inFreeTrial()) return false;
  if (await subscription.chargesCompleted()) return false;
  return !(
    subscription.renewalDisabledDueToIndianCardMandate && (await subscription.indiaCardMandateReliabilityEnabled())
  );
}

async function schedule(subscription: SubscriptionRecord, random: () => number): Promise<void> {
  const renewsAt = await subscription.endTimeOfSubscription();
  const days = renewalReminderEmailDays(await subscription.recurrence());
  if (days === undefined) throw new TypeError("nil can't be coerced into Float");
  let remindAt = advance(renewsAt, { days: -days });
  const now = subscription.now();

  if (remindAt.getTime() <= now.getTime()) {
    // Spread, but never past half the time left before the charge: `((renews_at - now) / 2).clamp(0, DUE_NOW_SPREAD)`.
    const half = (renewsAt.getTime() - now.getTime()) / 2000;
    const spread = Math.min(Math.max(half, 0), DUE_NOW_SPREAD_SECONDS);
    remindAt = new Date(now.getTime() + random() * spread * 1000);
  }
  await performAsync(REMINDER_JOB, [subscription.id], { at: remindAt });
}

export async function backfillMembershipRenewalReminders(deps: JobDeps, extra: BackfillDeps): Promise<void> {
  const redis = extra.redis();
  const claimed = await redis.set(
    RUNNING_KEY,
    String(Math.floor(deps.now().getTime() / 1000)),
    "EX",
    RUNNING_TTL_SECONDS,
    "NX",
  );
  if (claimed === null) throw new Error(`BackfillMembershipRenewalReminders is already running (${RUNNING_KEY})`);

  try {
    const startAfter = rubyToI(await redis.get(CURSOR_KEY));
    const where = Prisma.sql`${column(SUBSCRIPTIONS, "cancelled_at")} IS NULL AND (id > ${String(startAfter)})`;
    await findInBatches<Subscription>(SUBSCRIPTIONS, where, BATCH_SIZE, async (rows) => {
      for (const row of rows) {
        const subscription = new SubscriptionRecord(row, { now: deps.now, featureActive: extra.featureActive });
        try {
          if (await eligible(subscription)) await schedule(subscription, extra.random);
        } catch (error) {
          if (!isRubyStandardError(error)) throw new HandBackToRuby(`subscription ${row.id}: ${String(error)}`);
        }
        // Per row, so a crash re-schedules at most the row in flight.
        await redis.multi().set(CURSOR_KEY, String(row.id)).expire(RUNNING_KEY, RUNNING_TTL_SECONDS).exec();
      }
    });
  } finally {
    await redis.del(RUNNING_KEY);
  }
}

export const backfillMembershipRenewalRemindersJobWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<BackfillDeps> = {},
) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    await backfillMembershipRenewalReminders(deps, { ...defaultBackfillDeps, ...extras });
  })(overrides);

export const backfillMembershipRenewalRemindersJob = backfillMembershipRenewalRemindersJobWith();
