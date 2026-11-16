// `Purchase.where(email:, purchaser_id: nil).each { |purchase| purchase.attach_to_user_and_card(user, nil, nil) }` for a user this call just
// created (find_or_create_for_google_oauth2; Apple's loop is the same one, with the preorder, subscription and bundle kinds still handed back
// ahead of its code). No chargeable is passed, so the card branch never runs; the test-purchase and seller guards cannot fire for a new user.
import type { Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { isBlank } from "../html/text-helper.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { Preorders } from "./preorder.ts";
import { changePurchaser } from "./purchase-delivery-writes.ts";
import { loadSubscription, Subscriptions } from "./subscription-writes.ts";
import { defaultSubscriptionDeps } from "./subscription.ts";

// Purchase.where(email:, purchaser_id: nil), in primary key order as MySQL returns it. The comparison is the column's case-insensitive one.
export const guestPurchases = (email: string) =>
  db.purchase.findMany({ where: { email, purchaser_id: null }, orderBy: { id: "asc" } });

// Purchase#attach_to_user_and_card(user, nil, nil). False where Rails returns false: a reassignment-locked purchase stays where it is.
export async function attachToUser(row: Purchase, userId: bigint, now: () => Date): Promise<boolean> {
  if (PurchaseFlags.isSet(row.flags, "is_reassignment_locked")) return false;

  if (row.preorder_id !== null) {
    const preorder = await db.preorder.findUnique({ where: { id: Number(row.preorder_id) } });
    if (preorder !== null)
      await Preorders.updateBang(Preorders.load(preorder), { purchaser_id: Number(userId) }, { now });
  }

  if (row.subscription_id !== null && !PurchaseFlags.isSet(row.flags, "is_gift_sender_purchase")) {
    const subscription = await db.subscription.findUnique({ where: { id: row.subscription_id } });
    if (subscription !== null) {
      const record = loadSubscription(subscription, { now, featureActive: defaultSubscriptionDeps.featureActive });
      await Subscriptions.updateBang(record, { user_id: Number(userId) } as never, { now });
    }
  }

  // `save!(validate: false)`: its after_save attaches the unclaimed purchases of a bundle (purchase-delivery-writes.ts).
  await changePurchaser(row, userId, { now });
  return true;
}

export async function attachGuestPurchases(email: string | null, userId: bigint, now: () => Date): Promise<void> {
  if (email === null || isBlank(email)) return;
  for (const purchase of await guestPurchases(email)) await attachToUser(purchase, userId, now);
}
