// Ports of the jobs that read a subscription's billing period and queue a reminder:
//   app/sidekiq/free_trial_expiring_reminder_worker.rb
//   app/sidekiq/charge_declined_reminder_worker.rb
//   app/sidekiq/recurring_charge_reminder_worker.rb
//   app/sidekiq/review_reminder_job.rb
//   app/sidekiq/send_auto_invoice_email_job.rb (the eligibility read; an eligible buyer is handed back)
//   app/sidekiq/find_subscriptions_with_missing_charge_worker.rb
// Mail goes out as Rails' `deliver_later` would push it (the mailers are not ported). Anything Node
// cannot compute (a purchasing-power-parity price, Stripe Connect routing) throws
// NotPortedError before the job's first write, which hands the job to Rails.
// Golden: __fixtures__/subscription-reminder-jobs.golden.json (scripts/golden/subscription-reminder-jobs.rb).
import {
  Prisma,
  type BasePrice,
  type Link,
  type PaymentOption,
  type Purchase,
  type Subscription,
  type User,
} from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import {
  autoInvoiceEligible,
  findByPurchaseOrCharge,
  findChargeOrNil,
  findPurchaseOrNil,
} from "../../server/models/charge.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { advance } from "../../server/models/concerns/ruby-time.ts";
import { allowsReviewToBeCounted, PURCHASES } from "../../server/models/purchase.ts";
import { findById, findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo, uncached } from "../../server/models/runtime/query-cache.ts";
import {
  ensureMailerUniqueness,
  mailerKeyDigest,
  sentEmailKeyExists,
  setSentEmailKey,
} from "../../server/models/sent-email-info.ts";
import { castRow, columnIn, findInBatches, quoteName, selectRows, table, column } from "../../server/models/sql.ts";
import {
  defaultSubscriptionDeps,
  notIsTestSubscription,
  purchaseFlagScope,
  renewalAdvanceReminderEmailDays,
  renewalReminderEmailDays,
  SUBSCRIPTIONS,
  SubscriptionRecord,
  type SubscriptionDeps,
} from "../../server/models/subscription.ts";
import { NotPortedError, RISK_STATES, UserFlags } from "../../server/models/user.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";
import type { JobContext } from "./types.ts";

const CUSTOMER_LOW_PRIORITY_MAILER = "CustomerLowPriorityMailer";
const LOW_QUEUE = "low";

export type SubscriptionJobDeps = Pick<SubscriptionDeps, "featureActive">;

// A job argument that doubles as a mail argument and part of a SentEmailInfo digest keeps its type.
export function mailerArgument(value: JsonValue): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value))
    return value as string | number | boolean | null;
  throw new NotPortedError(`a ${typeof value} mail argument`, "the argument's Ruby #inspect is not ported");
}

const subscriptionRecord = (row: Subscription, deps: JobDeps, extras: Partial<SubscriptionJobDeps>) =>
  new SubscriptionRecord(row, {
    now: deps.now,
    featureActive: extras.featureActive ?? defaultSubscriptionDeps.featureActive,
  });

async function findSubscription(argument: JsonValue): Promise<Subscription> {
  return findByIdBang<Subscription>("Subscription", recordIdFrom(argument, "Subscription.find"));
}

export async function deliverReminder(context: JobContext, method: string, argument: JsonValue): Promise<void> {
  await deliverLater(
    context.runtime,
    { mailer: CUSTOMER_LOW_PRIORITY_MAILER, method, args: [mailerArgument(argument)], queue: LOW_QUEUE },
    mailRoute(CUSTOMER_LOW_PRIORITY_MAILER, method),
  );
}

// FreeTrialExpiringReminderWorker
export const freeTrialExpiringReminderWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<SubscriptionJobDeps> = {},
) =>
  modelJob({ min: 1 }, async (args, deps, context) => {
    const subscriptionId = args[0]!;
    // The whole body reads the primary: a cold replica can lack the preceding worker's marker.
    await connectedTo("writing", async () => {
      const digest = await beforeSideEffects(async () => {
        const subscription = subscriptionRecord(await findSubscription(subscriptionId), deps, extras);
        const remind =
          subscription.alive(false) &&
          subscription.inFreeTrial() &&
          !(
            subscription.renewalDisabledDueToIndianCardMandate &&
            (await subscription.indiaCardMandateReliabilityEnabled())
          ) &&
          !subscription.isTestSubscription;
        if (!remind) return null;
        const key = mailerKeyDigest(
          CUSTOMER_LOW_PRIORITY_MAILER,
          "free_trial_expiring_soon",
          mailerArgument(subscriptionId),
        );
        return (await sentEmailKeyExists(key)) ? null : key;
      });
      if (digest === null) return;

      await deliverReminder(context, "free_trial_expiring_soon", subscriptionId);
      await setSentEmailKey(digest, deps.now);
    });
  })(overrides);

// ChargeDeclinedReminderWorker
export const chargeDeclinedReminderWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<SubscriptionJobDeps> = {},
) =>
  modelJob({ min: 1 }, async (args, deps, context) => {
    const subscriptionId = args[0]!;
    const remind = await beforeSideEffects(async () => {
      const subscription = subscriptionRecord(await findSubscription(subscriptionId), deps, extras);
      if (
        (await subscription.indiaCardMandateReliabilityEnabled()) &&
        subscription.renewalDisabledDueToIndianCardMandate
      )
        return false;
      return !(
        !subscription.alive(false) ||
        subscription.isTestSubscription ||
        !(await subscription.overdueForCharge())
      );
    });
    if (remind) await deliverReminder(context, "subscription_card_declined_warning", subscriptionId);
  })(overrides);

const ADVANCE = "advance";

// RecurringChargeReminderWorker#advance_due?: not before the lead time of the advance notice, and
// not once the final reminder is due.
async function advanceDue(subscription: SubscriptionRecord): Promise<boolean> {
  const lead = renewalAdvanceReminderEmailDays(await subscription.recurrence());
  if (lead === null) return false;

  const renewsAt = await subscription.endTimeOfSubscription();
  const now = subscription.now();
  return (
    advance(renewsAt, { days: -lead }).getTime() <= now.getTime() &&
    advance(renewsAt, { days: -renewalReminderEmailDays(await subscription.recurrence())! }).getTime() > now.getTime()
  );
}

// RecurringChargeReminderWorker
export const recurringChargeReminderWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<SubscriptionJobDeps> = {},
) =>
  modelJob({ min: 1, max: 2 }, async (args, deps, context) => {
    const [subscriptionId, kind] = args as [JsonValue, JsonValue | undefined];
    const plan = await beforeSideEffects(async () => {
      const subscription = subscriptionRecord(await findSubscription(subscriptionId), deps, extras);
      const skip =
        !subscription.alive(false) ||
        subscription.inFreeTrial() ||
        (await subscription.chargesCompleted()) ||
        (subscription.renewalDisabledDueToIndianCardMandate &&
          (await subscription.indiaCardMandateReliabilityEnabled())) ||
        !(await subscription.sendRenewalReminders());
      if (skip) return "none" as const;
      if (kind !== ADVANCE) {
        mailerArgument(subscriptionId);
        return "final" as const;
      }
      return (await advanceDue(subscription)) ? subscription : ("none" as const);
    });

    if (plan === "none") return;
    if (plan === "final") {
      await deliverReminder(context, "subscription_renewal_reminder", subscriptionId);
      return;
    }

    // The marker is read from the primary: a cold replica can still lack the previous run's.
    await connectedTo("writing", async () => {
      const subscription = plan;
      const digest = await beforeSideEffects(async () =>
        mailerKeyDigest(
          CUSTOMER_LOW_PRIORITY_MAILER,
          "subscription_renewal_reminder",
          Number(subscription.id),
          ADVANCE,
          Math.floor((await subscription.endTimeOfSubscription()).getTime() / 1000),
        ),
      );
      if (await sentEmailKeyExists(digest)) return;

      await deliverLater(
        context.runtime,
        {
          mailer: CUSTOMER_LOW_PRIORITY_MAILER,
          method: "subscription_renewal_reminder",
          args: [Number(subscription.id)],
          queue: LOW_QUEUE,
        },
        mailRoute(CUSTOMER_LOW_PRIORITY_MAILER, "subscription_renewal_reminder"),
      );
      await setSentEmailKey(digest, deps.now);
    });
  })(overrides);

// ReviewReminderJob
export const reviewReminderJobWith = (overrides: Partial<JobDeps> = {}) =>
  modelJob({ min: 1 }, async (args, deps, context) => {
    const purchaseId = args[0]!;
    const eligible = await beforeSideEffects(async () => {
      const purchase = await findByIdBang<Purchase>("Purchase", recordIdFrom(purchaseId, "Purchase.find"));
      mailerArgument(purchaseId);
      return eligibleForReviewReminder(purchase);
    });
    if (!eligible) return;

    await ensureMailerUniqueness(
      CUSTOMER_LOW_PRIORITY_MAILER,
      "review_reminder",
      [mailerArgument(purchaseId)],
      () => deliverReminder(context, "purchase_review_reminder", purchaseId),
      deps.now,
    );
  })(overrides);

// Purchase#eligible_for_review_reminder?
export async function eligibleForReviewReminder(purchase: Purchase): Promise<boolean> {
  if (!allowsReviewToBeCounted(purchase)) return false;
  if ((await findOneBy("ProductReview", "purchase_id", purchase.id)) !== null) return false;
  const seller = await findById<User>("User", purchase.seller_id);
  if (seller !== null && UserFlags.isSet(seller.flags, "disable_review_reminders")) return false;
  if (!purchase.can_contact) return false;
  const purchaser = await findById<User>("User", purchase.purchaser_id);
  return purchaser === null ? true : !UserFlags.isSet(purchaser.flags, "opted_out_of_review_reminders");
}

// SendAutoInvoiceEmailJob: CustomerMailer.auto_invoice is delivered inline and not ported, so an
// eligible buyer is handed back to Rails.
export const sendAutoInvoiceEmailJobWith = (overrides: Partial<JobDeps> = {}) =>
  modelJob({ min: 2 }, async (args) => {
    const [purchaseId, chargeId] = args as [JsonValue, JsonValue];
    await beforeSideEffects(async () => {
      const optionalId = (value: JsonValue, call: string) => (value === null ? null : recordIdFrom(value, call));
      const purchaseKey = optionalId(purchaseId, "Purchase.find_by");
      const chargeKey = optionalId(chargeId, "Charge.find_by");
      const purchase = await findPurchaseOrNil(purchaseKey);
      const charge = await findChargeOrNil(chargeKey);
      if (!(await autoInvoiceEligible(await findByPurchaseOrCharge(purchase, charge)))) return;
      throw new NotPortedError("CustomerMailer.auto_invoice", "send_auto_invoice_email_job.rb:14");
    });
  })(overrides);

// ---------------------------------------------------------------------------------------------
// FindSubscriptionsWithMissingChargeWorker

const BATCHES = 10;
const BATCHES_SCHEDULE_MARGIN_IN_MINUTES = 20;
const BATCH_SIZE = 1_000;
const SUSPECTED_MISSING_AFTER_SECONDS = 75 * 60;
const FIND_MISSING_CHARGE_JOB = "FindSubscriptionsWithMissingChargeWorker";
const RECURRING_CHARGE_WORKER = "RecurringChargeWorker";

// Distinct non-nil keys in first-appearance order, as the preloader collects them.
const idList = (values: readonly (bigint | number | null)[]): (bigint | number)[] => {
  const seen = new Map<string, bigint | number>();
  for (const value of values) if (value !== null && !seen.has(String(value))) seen.set(String(value), value);
  return [...seen.values()];
};

// `includes(...)` of a belongs_to: one statement for the distinct keys (skipped when there are none),
// answered rows by id.
async function preloadBy<R extends { id: bigint | number }>(
  model: "Link" | "User" | "PaymentOption" | "BasePrice",
  tableName: string,
  ids: (bigint | number)[],
): Promise<Map<string, R>> {
  if (ids.length === 0) return new Map();
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(tableName)}.*`)} FROM ${table(tableName)} WHERE ${columnIn(tableName, "id", ids)}`,
  );
  return new Map(rows.map((row) => castRow<R>(model, row)).map((record) => [String(record.id), record]));
}

export const findSubscriptionsWithMissingChargeWorkerWith = (
  overrides: Partial<JobDeps> = {},
  extras: Partial<SubscriptionJobDeps> = {},
) =>
  modelJob({ min: 0, max: 1 }, async (args, deps) => {
    const batchNumber = args[0] ?? null;
    if (batchNumber === null) {
      for (let i = 0; i < BATCHES; i++)
        await performAsync(FIND_MISSING_CHARGE_JOB, [i], { delaySeconds: i * BATCHES_SCHEDULE_MARGIN_IN_MINUTES * 60 });
      return;
    }
    // `subscriptions.id % 10 = ?` quotes the number as a String.
    await beforeSideEffects(() => {
      if (typeof batchNumber !== "number" || !Number.isSafeInteger(batchNumber))
        throw new NotPortedError(
          `perform(${JSON.stringify(batchNumber)})`,
          "find_subscriptions_with_missing_charge_worker.rb:15",
        );
    });

    // RecurringChargeWorker is queued once a batch has been judged. Node holds the pushes until the
    // job ends so that a case it cannot judge (NotPortedError) can still be handed back to Rails with
    // nothing pushed; a plain failure flushes the batches already judged, as Ruby had pushed them.
    const pending: number[] = [];
    const flush = async () => {
      for (const id of pending.splice(0)) await performAsync(RECURRING_CHARGE_WORKER, [id, true]);
    };

    try {
      await findInBatches<Record<string, unknown>>(
        SUBSCRIPTIONS,
        Prisma.sql`${notIsTestSubscription()} AND ${column(SUBSCRIPTIONS, "deactivated_at")} IS NULL AND (subscriptions.id % 10 = ${String(batchNumber)})`,
        BATCH_SIZE,
        async (rows) => {
          pending.push(...(await judgeBatch(rows, deps, extras)));
        },
      );
    } catch (error) {
      // judgeBatch wraps its reads in beforeSideEffects, so a refusal arrives here as HandBackToRuby.
      if (error instanceof HandBackToRuby || (error instanceof Error && error.name === "NotPortedError")) throw error;
      await flush();
      throw error;
    }
    await flush();
  })(overrides);

// One `find_in_batches` batch: the ids of the subscriptions to charge again.
async function judgeBatch(
  rows: Record<string, unknown>[],
  deps: JobDeps,
  extras: Partial<SubscriptionJobDeps>,
): Promise<number[]> {
  const batch = rows.map((row) => castRow<Subscription>("Subscription", row));

  // `includes(link: :user)` skips the query cache with the batch load.
  const { links, users } = await beforeSideEffects(() =>
    uncached(async () => {
      const links = await preloadBy<Link>("Link", "links", idList(batch.map((subscription) => subscription.link_id)));
      const users = await preloadBy<User>("User", "users", idList([...links.values()].map((link) => link.user_id)));
      return { links, users };
    }),
  );

  let kept = await beforeSideEffects(async () => {
    const result: Subscription[] = [];
    for (const subscription of batch) {
      const link = subscription.link_id === null ? undefined : links.get(String(subscription.link_id));
      if (link === undefined) throw new TypeError("undefined method 'user' for nil");
      const owner = link.user_id === null ? undefined : users.get(String(link.user_id));
      if (owner === undefined) throw new TypeError("undefined method 'suspended?' for nil");
      const suspended = (RISK_STATES.SUSPENDED as readonly string[]).includes(owner.user_risk_state ?? "");
      if (suspended || (await subscriptionRecord(subscription, deps, extras).hasAChargeInProgress())) continue;
      result.push(subscription);
    }
    return result;
  });
  if (kept.length === 0) return [];

  // `Subscription.where(id: ids).includes(:original_purchase)`
  const priced = await beforeSideEffects(async () => {
    const ids = kept.map((subscription) => subscription.id);
    const subscriptions = (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw(`${quoteName(SUBSCRIPTIONS)}.*`)} FROM ${table(SUBSCRIPTIONS)} WHERE ${columnIn(SUBSCRIPTIONS, "id", ids)}`,
      )
    ).map((row) => castRow<Subscription>("Subscription", row));
    const originals = (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PURCHASES)}.*`)} FROM ${table(PURCHASES)} WHERE ${purchaseFlagScope("is_original_subscription_purchase", true)} AND ${purchaseFlagScope("is_archived_original_subscription_purchase", false)} AND ${columnIn(
          PURCHASES,
          "subscription_id",
          subscriptions.map((subscription) => subscription.id),
        )}`,
      )
    ).map((row) => castRow<Purchase>("Purchase", row));
    const result: Subscription[] = [];
    for (const subscription of subscriptions) {
      const record = subscriptionRecord(subscription, deps, extras);
      record.preload(
        "original_purchase",
        originals.find((purchase) => purchase.subscription_id === subscription.id) ?? null,
      );
      if ((await record.currentSubscriptionPriceCents()) !== 0) result.push(subscription);
    }
    return result;
  });
  kept = priced;
  if (kept.length === 0) return [];

  // `Subscription.includes(:last_successful_purchase, last_payment_option: :price).where(id: ids)`
  return beforeSideEffects(async () => {
    const ids = kept.map((subscription) => subscription.id);
    const subscriptions = (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw(`${quoteName(SUBSCRIPTIONS)}.*`)} FROM ${table(SUBSCRIPTIONS)} WHERE ${columnIn(SUBSCRIPTIONS, "id", ids)}`,
      )
    ).map((row) => castRow<Subscription>("Subscription", row));
    const successful = (
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw(`${quoteName(PURCHASES)}.*`)} FROM ${table(PURCHASES)} WHERE ${column(PURCHASES, "purchase_state")} = ${"successful"} AND ${columnIn(
          PURCHASES,
          "subscription_id",
          subscriptions.map((subscription) => subscription.id),
        )} ORDER BY ${column(PURCHASES, "created_at")} DESC`,
      )
    ).map((row) => castRow<Purchase>("Purchase", row));
    const options = await preloadBy<PaymentOption>(
      "PaymentOption",
      "payment_options",
      idList(subscriptions.map((subscription) => subscription.last_payment_option_id)),
    );
    const prices = await preloadBy<BasePrice>(
      "BasePrice",
      "prices",
      idList([...options.values()].map((option) => option.price_id)),
    );

    const result: number[] = [];
    for (const subscription of subscriptions) {
      const record = subscriptionRecord(subscription, deps, extras);
      const lastSuccessful = successful.find((purchase) => purchase.subscription_id === subscription.id) ?? null;
      const option =
        subscription.last_payment_option_id === null
          ? null
          : (options.get(String(subscription.last_payment_option_id)) ?? null);
      record.preload("last_payment_option", option);
      if (option !== null)
        record.preload(
          `price:${String(option.id)}`,
          option.price_id === null ? null : (prices.get(String(option.price_id)) ?? null),
        );

      // A hold may have no paid period to be overdue from, and nothing else rechecks its mandate.
      if (record.indianCardMandateHeld()) {
        result.push(Number(subscription.id));
        continue;
      }
      if (lastSuccessful === null || (await record.secondsOverdueForCharge()) < SUSPECTED_MISSING_AFTER_SECONDS)
        continue;
      result.push(Number(subscription.id));
    }
    return result;
  });
}

export const freeTrialExpiringReminderWorker = freeTrialExpiringReminderWorkerWith();
export const chargeDeclinedReminderWorker = chargeDeclinedReminderWorkerWith();
export const recurringChargeReminderWorker = recurringChargeReminderWorkerWith();
export const reviewReminderJob = reviewReminderJobWith();
export const sendAutoInvoiceEmailJob = sendAutoInvoiceEmailJobWith();
export const findSubscriptionsWithMissingChargeWorker = findSubscriptionsWithMissingChargeWorkerWith();
