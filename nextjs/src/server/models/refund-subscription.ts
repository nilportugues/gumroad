// What refund_purchase! (app/modules/purchase/refundable.rb) does for a membership charge: `subscription.cancel_immediately_if_pending_cancellation!`
// and, after the VAT credit, `subscription.original_purchase.update!(should_exclude_product_review: true)` for a free trial whose charge was
// reversed (Subscription#should_exclude_product_review_on_charge_reversal?). Golden: __fixtures__/refund-purchase-body.golden.json
// (scripts/golden/refund-purchase-body.rb).
import { Prisma, type Purchase, type Subscription } from "@prisma/client";

import { PurchaseFlags } from "../search/flags.ts";

import { type PurchaseRecord } from "./purchase-create.ts";
import { Purchases } from "./purchase-create.ts";
import { loadLinkAssociations } from "./purchase-reloaded-associations.ts";
import { allowsReviewToBeCounted } from "./purchase.ts";
import { heldSubscription, holdSubscription } from "./refund-held-associations.ts";
import { siblingRecord } from "./refund-purchase-effects.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import {
  deactivateBang,
  loadSubscription,
  readWorkflowsForCancellation,
  subscriptionView,
  withLock,
} from "./subscription-writes.ts";
import { defaultSubscriptionDeps } from "./subscription.ts";
import { NotPortedError } from "./user.ts";

// `subscription.cancel_immediately_if_pending_cancellation! if subscription.present?`
export async function cancelImmediatelyIfPendingCancellationBang(
  purchase: PurchaseRecord,
  options: SaveOptions = {},
): Promise<void> {
  const subscriptionId = purchase.get("subscription_id");
  if (subscriptionId == null) {
    holdSubscription(purchase, { subscription: null });
    return;
  }
  const [row] = await selectRows<Subscription>(
    Prisma.sql`SELECT ${Prisma.raw("`subscriptions`.*")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} = ${subscriptionId} LIMIT 1`,
  );
  const now = options.now ?? (() => new Date());
  const subscription =
    row === undefined
      ? null
      : loadSubscription(castRow<Subscription>("Subscription", row), { ...defaultSubscriptionDeps, now });
  holdSubscription(purchase, { subscription });
  if (subscription === null) return;

  await withLock(subscription, async () => {
    // pending_cancellation?: alive? && cancelled_at.present?
    if (!subscriptionView(subscription).alive(true) || subscription.get("cancelled_at") == null) return;
    subscription.set("cancelled_at", now());
    await deactivateBang(subscription, { workflows: () => readWorkflowsForCancellation(subscription) });
  });
}

// `subscription.original_purchase.update!(should_exclude_product_review: true) if subscription&.should_exclude_product_review_on_charge_reversal?`
export async function excludeProductReviewOnChargeReversalBang(
  purchase: PurchaseRecord,
  options: SaveOptions = {},
): Promise<void> {
  const subscription = heldSubscription(purchase)?.subscription;
  if (subscription === undefined || subscription === null) return;
  // has_free_trial? && !original_purchase.should_exclude_product_review? && !first_successful_charge&.allows_review?
  if (subscription.get("free_trial_ends_at") == null) return;
  const view = subscriptionView(subscription);
  const original = await view.originalPurchase();
  if (original === null) throw new TypeError("undefined method 'should_exclude_product_review?' for nil");
  if (PurchaseFlags.isSet(original.flags, "should_exclude_product_review")) return;
  const [first] = await selectRows<Purchase>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "subscription_id")} = ${subscription.get("id")} AND ${column("purchases", "purchase_state")} = 'successful' ORDER BY ${column("purchases", "id")} ASC LIMIT 1`,
  );
  // no golden has a first charge that already counts for reviews
  if (first !== undefined && allowsReviewToBeCounted(castRow<Purchase>("Purchase", first), true))
    throw new NotPortedError(
      "Purchase#refund_purchase! with a free trial whose first charge counts for reviews",
      "app/modules/purchase/refundable.rb:288",
    );

  const record = siblingRecord(original, purchase);
  // loading it through the subscription reads these two first, which is the order PaperTrail records the row in
  record.touch("subscription_id");
  // the inverse of subscription.original_purchase
  holdSubscription(record, { subscription });
  record.set("flags", PurchaseFlags.set(record.get("flags"), "should_exclude_product_review", true) as never);
  await loadLinkAssociations(record);
  await Purchases.saveBang(record, options);
}
