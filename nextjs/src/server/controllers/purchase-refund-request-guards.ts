// What Purchases::RefundRequestsController's two actions share: the before_actions and the refund window. A module of its own, so
// the page (page-props/buyer/refund-request-page.ts) can import it without pulling in the mutation registry.
import type { Purchase } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { REFUND_REQUEST_SECURE_ID_SCOPE, REFUND_REQUESTS_FEATURE } from "../models/purchase-refund-request.ts";
import { decryptSecureExternalId } from "../models/secure-external-id.ts";
import { trueOriginalPurchaseOf } from "../page-props/buyer/subscriptions.ts";

import { HandBackToRails, RoutingError } from "./application-controller.ts";

// `set_no_store_and_referrer_policy`: the signed token is the URL itself.
export const REFUND_REQUEST_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

// PurchaseRefundRequest.refund_period_in_days: the purchase's own policy, else its subscription's original purchase's. The
// first policy found decides, even when its period is empty. A preorder's authorization purchase is Rails'.
export async function refundPeriodInDays(purchase: Purchase): Promise<number | null> {
  const own = await db.purchaseRefundPolicy.findFirst({ where: { purchase_id: purchase.id } });
  if (own) return own.max_refund_period_in_days;
  if (purchase.subscription_id !== null) {
    const subscription = await db.subscription.findUnique({ where: { id: purchase.subscription_id } });
    if (!subscription) throw new HandBackToRails("a purchase whose subscription row is missing");
    const original = await trueOriginalPurchaseOf(subscription.id);
    const inherited = original
      ? await db.purchaseRefundPolicy.findFirst({ where: { purchase_id: original.id } })
      : null;
    if (inherited) return inherited.max_refund_period_in_days;
  }
  if (purchase.preorder_id !== null)
    throw new HandBackToRails("a preorder charge, whose policy is on its authorization purchase");
  return null;
}

// `set_purchase` and `check_feature_flag`: a token that does not read back as a purchase, or a seller outside the flag, is a 404.
export async function purchaseForRefundRequest(token: string, now: Date): Promise<Purchase> {
  const id = decryptSecureExternalId("Purchase", token, REFUND_REQUEST_SECURE_ID_SCOPE, now);
  const purchase = id === null ? null : await db.purchase.findUnique({ where: { id: BigInt(id) } });
  if (!purchase) throw new RoutingError("Not Found");
  if (purchase.seller_id === null) throw new HandBackToRails("a purchase with no seller");
  if (!(await isFeatureEnabled(REFUND_REQUESTS_FEATURE, userActor(purchase.seller_id))))
    throw new RoutingError("Not Found");
  return purchase;
}
