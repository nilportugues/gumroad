// Port of app/sidekiq/order_review_reminder_job.rb: the review reminder for an order is one email to the order's purchaser when its
// eligible purchases share an address, else one per purchase (a gift sender's purchase is resolved to the receiver's). Each
// reminder's SentEmailInfo key is recorded only after the push, so a retry may repeat one email but never skips one.
// Ruby's `downcase` is full Unicode and Node's is not byte for byte, so an address with a non-ASCII letter is handed back with
// nothing written. Golden: __fixtures__/order-review-reminder-job.golden.json (scripts/golden/order-review-reminder-job.rb).
import { Prisma, type Gift, type Order, type Purchase } from "@prisma/client";

import { beforeSideEffects, HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { mailerKeyDigest, sentEmailKeyExists, setSentEmailKey } from "../../server/models/sent-email-info.ts";
import { PurchaseFlags } from "../../server/search/flags.ts";
import { findById, findByIdBang, findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";
import { deliverReminder, eligibleForReviewReminder, mailerArgument } from "./subscription-reminder-jobs.ts";
import type { JobContext } from "./types.ts";

const MAILER = "CustomerLowPriorityMailer";
const ORDER_REMINDER = "order_review_reminder";
const PURCHASE_REMINDER = "purchase_review_reminder";
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

// Purchase#purchase_for_review_reminder
async function purchaseForReviewReminder(purchase: Purchase): Promise<Purchase | null> {
  if (!PurchaseFlags.isSet(purchase.flags, "is_gift_sender_purchase")) return purchase;
  const gift = await findOneBy<Gift>("Gift", "gifter_purchase_id", purchase.id);
  return gift === null ? null : findById<Purchase>("Purchase", gift.giftee_purchase_id);
}

// Recorded after the push, unlike SentEmailInfo.ensure_mailer_uniqueness, so a crash in between repeats an email instead of
// skipping it for good.
async function enqueueReminderOnce(context: JobContext, method: string, argument: number | string, now: () => Date) {
  const digest = mailerKeyDigest(MAILER, method, argument);
  if (await sentEmailKeyExists(digest)) return;
  await deliverReminder(context, method, argument);
  await setSentEmailKey(digest, now);
}

export const orderReviewReminderJobWith = modelJob({ min: 1 }, async ([orderId], deps, context) => {
  const order = await beforeSideEffects(() => {
    mailerArgument(orderId!);
    return findByIdBang<Order>("Order", recordIdFrom(orderId, "Order.find"));
  });

  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} INNER JOIN ${table("order_purchases")} ON ${column("purchases", "id")} = ${column("order_purchases", "purchase_id")} WHERE ${column("order_purchases", "order_id")} = ${order.id}`,
  );
  // `uniq` on the resolved records: one entry per id, in order of first appearance.
  const resolved = new Map<string, Purchase>();
  for (const row of rows) {
    const purchase = await purchaseForReviewReminder(castRow<Purchase>("Purchase", row));
    if (purchase !== null) resolved.set(String(purchase.id), purchase);
  }
  const eligible: Purchase[] = [];
  for (const purchase of resolved.values()) if (await eligibleForReviewReminder(purchase)) eligible.push(purchase);

  if (eligible.some((purchase) => !PRINTABLE_ASCII.test(purchase.email ?? ""))) {
    throw new HandBackToRuby("an address with a non-ASCII character, whose Ruby downcase is not ported");
  }
  const addresses = new Set(eligible.map((purchase) => purchase.email?.toLowerCase() ?? null));
  addresses.delete(null);
  // `uniq.one?` counts truthy entries: a missing address next to one shared address does not split the order, while an
  // order with no address at all is served one purchase at a time.
  const sharedAddress =
    eligible.length > 1 &&
    !eligible.some((purchase) => PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase")) &&
    addresses.size === 1;

  if (sharedAddress) {
    await enqueueReminderOnce(context, ORDER_REMINDER, mailerArgument(orderId!) as number | string, deps.now);
  } else {
    for (const purchase of eligible) await enqueueReminderOnce(context, PURCHASE_REMINDER, Number(purchase.id), deps.now);
  }
});

export const orderReviewReminderJob = orderReviewReminderJobWith();
