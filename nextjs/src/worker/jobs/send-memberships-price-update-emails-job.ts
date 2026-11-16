// Port of app/sidekiq/send_memberships_price_update_emails_job.rb: every alive, unapplied product price change that takes effect within
// seven days and has not been notified is claimed (a UUID and a timestamp under the row lock, honoured for three hours) and handed to
// SendMembershipPriceUpdateEmailJob, an ActiveJob Rails runs. A push that fails releases the claim and the error propagates, so the
// remaining plan changes wait for the next run. Plan changes load in batches of 1000 with their subscriptions preloaded per batch.
// Golden: __fixtures__/send-memberships-price-update-emails-job.golden.json
// (scripts/golden/send-memberships-price-update-emails-job.rb); the 1000-row batch boundary is findInBatches', not recorded here.
import { Prisma, type Subscription, type SubscriptionPlanChange } from "@prisma/client";

import { performLater } from "../../server/mail/active-job.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { castRow, column, columnIn, findInBatches, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PLAN_CHANGES = "subscription_plan_changes";
const EMAIL_JOB = "SendMembershipPriceUpdateEmailJob";
const EMAIL_JOB_QUEUE = "low";
const BATCH_SIZE = 1000;
const NOTIFICATION_LEAD_DAYS = 7;
const PRICE_CHANGE_NOTIFICATION_CLAIM_TTL_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
// SubscriptionPlanChange.flag_mapping["flags"]: for_product_price_change, applied
const FOR_PRODUCT_PRICE_CHANGE = 1;
const APPLIED = 2;

const planChange = (name: string) => column(PLAN_CHANGES, name);

// `with_lock { ... }`: the row reloaded under FOR UPDATE, `null` when it is gone
async function withLockedPlanChange<T>(
  id: bigint,
  body: (row: SubscriptionPlanChange) => Promise<T>,
): Promise<T | undefined> {
  return transaction(async (tx) => {
    const [row] = await tx.$queryRaw<SubscriptionPlanChange[]>(
      Prisma.sql`SELECT ${Prisma.raw("`subscription_plan_changes`.*")} FROM ${table(PLAN_CHANGES)} WHERE ${planChange("id")} = ${id} LIMIT 1 FOR UPDATE`,
    );
    if (row === undefined) return undefined;
    return body(castRow<SubscriptionPlanChange>("SubscriptionPlanChange", row));
  });
}

async function updateColumns(id: bigint, values: { claimId: string | null; claimedAt: Date | null }): Promise<void> {
  await transaction((tx) =>
    tx.$executeRaw(
      Prisma.sql`UPDATE ${table(PLAN_CHANGES)} SET ${planChange("notification_claim_id")} = ${values.claimId}, ${planChange("notification_claimed_at")} = ${values.claimedAt} WHERE ${planChange("id")} = ${id}`,
    ),
  );
}

export const sendMembershipsPriceUpdateEmailsJobWith = modelJob({ min: 0 }, async (_args, deps, { runtime }) => {
  const now = deps.now();
  const effectiveBy = new Date(now.getTime() + NOTIFICATION_LEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
  const where = Prisma.sql`${planChange("deleted_at")} IS NULL AND ((${planChange("flags")} & ${Prisma.raw(String(APPLIED))} = 0)) AND ((${planChange("flags")} & ${Prisma.raw(String(FOR_PRODUCT_PRICE_CHANGE))} = ${Prisma.raw(String(FOR_PRODUCT_PRICE_CHANGE))})) AND (effective_on <= ${effectiveBy}) AND ${planChange("notified_subscriber_at")} IS NULL`;

  await findInBatches<SubscriptionPlanChange>(PLAN_CHANGES, where, BATCH_SIZE, async (changes) => {
    const subscriptionIds = [...new Set(changes.map((change) => change.subscription_id))];
    const subscriptions = new Map(
      (
        await selectRows<Subscription>(
          Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table("subscriptions")} WHERE ${columnIn("subscriptions", "id", subscriptionIds)}`,
        )
      ).map((row) => [row.id, row]),
    );

    for (const change of changes) {
      const subscription = subscriptions.get(change.subscription_id);
      if (subscription === undefined) throw new TypeError("undefined method 'alive?' for nil");
      // `subscription.alive? && !subscription.pending_cancellation?`: alive (not failed or ended, not cancelled in the past) and not cancelled at all
      if (subscription.failed_at !== null || subscription.ended_at !== null || subscription.cancelled_at !== null)
        continue;

      // claim_price_change_notification
      const claimId = await withLockedPlanChange(change.id, async (row) => {
        if (row.notified_subscriber_at !== null) return undefined;
        if (
          row.notification_claim_id !== null &&
          row.notification_claim_id !== "" &&
          row.notification_claimed_at !== null &&
          row.notification_claimed_at.getTime() > now.getTime() - PRICE_CHANGE_NOTIFICATION_CLAIM_TTL_MS
        )
          return undefined;
        const id = deps.uuid();
        await updateColumns(row.id, { claimId: id, claimedAt: now });
        return id;
      });
      if (claimId === undefined) continue;

      try {
        await performLater(
          runtime,
          { jobClass: EMAIL_JOB, queue: EMAIL_JOB_QUEUE, args: [Number(change.id), claimId] },
          deps.uuid(),
        );
      } catch (error) {
        // release_price_change_notification_claim
        await withLockedPlanChange(change.id, async (row) => {
          if (row.notification_claim_id !== claimId || row.notified_subscriber_at !== null) return;
          await updateColumns(row.id, { claimId: null, claimedAt: null });
        });
        throw error;
      }
    }
  });
});

export const sendMembershipsPriceUpdateEmailsJob = sendMembershipsPriceUpdateEmailsJobWith();
