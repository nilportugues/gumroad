// Port of app/sidekiq/cancel_subscriptions_for_product_worker.rb up to the first Subscription#cancel_effective_immediately!: a product
// whose deletion was undone is left alone, and a deleted one with no active subscription is queued the seller's
// ContactingCreatorMailer#subscription_product_deleted on the critical queue, built as `deliver_later(queue: "critical")` builds it.
// An active subscription is cancelled through its payment, balance and mail callbacks, which stay with Rails: the job is handed back
// right after the subscriptions are read, before anything is written. An id Rails casts (a Float, a word) hands back before any
// statement. Golden: __fixtures__/cancel-subscriptions-for-product-worker.golden.json
// (scripts/golden/cancel-subscriptions-for-product-worker.rb).
import { Prisma, type Link } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { deliverLater } from "../../server/mail/active-job.ts";
import { mailRoute } from "../../server/mail/delivery.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { RecordNotFound } from "../../server/models/runtime/errors.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const MAILER = "ContactingCreatorMailer";
const METHOD = "subscription_product_deleted";
// Subscription.flag_mapping["flags"][:is_test_subscription], which Rails binds as a quoted string.
const IS_TEST_SUBSCRIPTION = "1";

export const cancelSubscriptionsForProductWorkerWith = modelJob({ min: 1 }, async ([productId], deps, { runtime }) => {
  if (productId === null) throw new RecordNotFound("Couldn't find Link without an ID");
  const id = await beforeSideEffects(() => recordIdFrom(productId, "Link.find"));
  const product = await findOneBy<Link>("Link", "id", id);
  if (product === null) throw new RecordNotFound(`Couldn't find Link with 'id'=${String(id)}`);
  if (product.deleted_at === null) return;

  // Subscription.active
  const subscriptions = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "link_id")} = ${id} AND (subscriptions.flags & ${IS_TEST_SUBSCRIPTION} = 0 and failed_at is null and ended_at is null and (cancelled_at is null or cancelled_at > ${deps.now()}))`,
  );
  if (subscriptions.length > 0) throw new HandBackToRuby("Subscription#cancel_effective_immediately! is not ported");

  await deliverLater(
    runtime,
    { mailer: MAILER, method: METHOD, args: [productId as string | number], queue: "critical" },
    mailRoute(MAILER, METHOD),
  );
});

export const cancelSubscriptionsForProductWorker = cancelSubscriptionsForProductWorkerWith();
