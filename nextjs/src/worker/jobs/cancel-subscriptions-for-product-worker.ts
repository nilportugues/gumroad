// Port of app/sidekiq/cancel_subscriptions_for_product_worker.rb for a deleted product with no active subscription: a missing product
// raises RecordNotFound, one whose deletion was undone finishes, and the seller is queued ContactingCreatorMailer#subscription_product_deleted
// on the critical queue. An active subscription is cancelled with `cancel_effective_immediately!`, whose validations, callbacks and
// Stripe/PayPal cancellations are not ported, so the job is handed back right after the subscriptions are read, with nothing written.
// Golden: __fixtures__/cancel-subscriptions-for-product-worker.golden.json (scripts/golden/cancel-subscriptions-for-product-worker.rb).
import { Prisma, type Link } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { column, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const SUBSCRIPTIONS = "subscriptions";
const MAILER = "ContactingCreatorMailer";
const METHOD = "subscription_product_deleted";
// Subscription.flag_mapping["flags"][:is_test_subscription], which Rails binds as a quoted string.
const IS_TEST_SUBSCRIPTION = "1";

// `product.subscriptions.active`, loaded
async function hasActiveSubscription(productId: bigint, now: Date): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(SUBSCRIPTIONS)}.*`)} FROM ${table(SUBSCRIPTIONS)} WHERE ${column(SUBSCRIPTIONS, "link_id")} = ${productId} AND (subscriptions.flags & ${IS_TEST_SUBSCRIPTION} = 0 and failed_at is null and ended_at is null and (cancelled_at is null or cancelled_at > ${now}))`,
  );
  return rows.length > 0;
}

export const cancelSubscriptionsForProductWorkerWith = modelJob({ min: 1 }, async ([productArg], deps, { runtime }) => {
  const id = await beforeSideEffects(() => recordIdFrom(productArg, "Link.find"));
  const product = await findByIdBang<Link>("Link", id);
  // user undid product deletion
  if (product.deleted_at === null) return;

  if (await hasActiveSubscription(id, deps.now()))
    throw new HandBackToRuby("Subscription#cancel_effective_immediately! is not ported");

  // The mailer takes the job's own argument, so a digit string stays a string.
  await deliverLater(
    runtime,
    { mailer: MAILER, method: METHOD, args: [productArg as number | string], queue: "critical" },
    mailRoute(MAILER, METHOD),
  );
});

export const cancelSubscriptionsForProductWorker = cancelSubscriptionsForProductWorkerWith();
