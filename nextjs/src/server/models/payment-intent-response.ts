// What Order::ChargeService#ensure_all_purchases_processed answers for a PaymentIntent that Stripe has not settled, and the abandonment
// job it schedules: the `requires_card_action` and `processing` line item bodies, the confirm-scoped order token inside the first, and
// the status checks of StripeChargeIntent that choose between the branches.
// Golden: __fixtures__/purchase-paid-order.golden.json (scripts/golden/purchase-paid-order.rb), run through the real app. Pure: nothing
// here reads or writes, so a caller can decide, before any write, which branch an intent takes.
import { secureExternalId } from "./secure-external-id.ts";

// ChargeProcessor::TIME_TO_COMPLETE_SCA
export const TIME_TO_COMPLETE_SCA_SECONDS = 15 * 60;
// `order.secure_external_id(scope: "confirm", expires_at: 1.hour.from_now)`
const CONFIRM_TOKEN_LIFETIME_SECONDS = 60 * 60;
const USE_STRIPE_SDK = "use_stripe_sdk";

export type PaymentIntentLike = { status: string; next_action?: { type?: string | null } | null };
export type IntentOutcome = "succeeded" | "requires_action" | "processing" | "other";

// StripeChargeIntent#succeeded?, #requires_action? (only the Stripe.js action counts: a redirect or a QR code is `other`) and #processing?
export function paymentIntentOutcome(intent: PaymentIntentLike): IntentOutcome {
  if (intent.status === "succeeded") return "succeeded";
  if (intent.status === "requires_action" && intent.next_action?.type === USE_STRIPE_SDK) return "requires_action";
  if (intent.status === "processing") return "processing";
  return "other";
}

// `order.secure_external_id(scope: "confirm", expires_at: 1.hour.from_now)`
export function confirmOrderToken(orderId: bigint | number, now: Date, randomIv?: (bytes: number) => Buffer): string {
  return secureExternalId("Order", orderId, "confirm", {
    expiresAt: new Date(now.getTime() + CONFIRM_TOKEN_LIFETIME_SECONDS * 1000),
    randomIv,
  });
}

// The line item body for a payment intent that needs the buyer's 3DS step. `stripeConnectAccountId` is the line's own Connect account
// (`purchase.merchant_account`), nil for a charge on Gumroad's.
export function requiresCardActionResponse(input: {
  intentId: string;
  clientSecret: string;
  permalink: string;
  orderToken: string;
  stripeConnectAccountId: string | null;
}) {
  return {
    success: true,
    requires_card_action: true,
    client_secret: input.clientSecret,
    intent_id: input.intentId,
    intent_type: "payment",
    permalink: input.permalink,
    order: { id: input.orderToken, stripe_connect_account_id: input.stripeConnectAccountId },
  };
}

// The line item body for an intent that is still processing (a debit scheduled for later): never a resubmittable failure.
export function processingResponse(permalink: string) {
  return { success: true, processing: true, permalink };
}

// `FailAbandonedPurchaseWorker.perform_in(ChargeProcessor::TIME_TO_COMPLETE_SCA, purchase.id)`: when it runs, in epoch seconds
export function failAbandonedPurchaseRunsAt(now: Date): number {
  return now.getTime() / 1000 + TIME_TO_COMPLETE_SCA_SECONDS;
}
