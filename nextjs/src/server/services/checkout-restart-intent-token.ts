// Checkout::RestartIntentToken.issue (app/services/checkout/restart_intent_token.rb): the signed proof that a buyer asked for this
// membership on this page load. `issued_at` and the expiry come from the clock, so two issues never match; the format is what the
// golden in __fixtures__/restart-intent-token.golden.json pins, and spec/services/checkout/restart_intent_token_node_spec.rb has Rails
// verify the tokens Node issued.
import { railsMessageVerifierGenerate } from "../auth/message-verifier.ts";

export const RESTART_INTENT_PURPOSE = "checkout_restart_intent";
// Checkout::RestartIntentToken::TTL
export const RESTART_INTENT_TTL_MS = 60 * 60 * 1000;

// `buyerId` is nil for a guest, who is signed too.
export function issueRestartIntentToken(productId: bigint, buyerId: bigint | null, now: Date = new Date()): string {
  const payload = {
    product_id: Number(productId),
    buyer_id: buyerId === null ? null : Number(buyerId),
    issued_at: now.getTime() / 1000,
  };
  return railsMessageVerifierGenerate(RESTART_INTENT_PURPOSE, payload, RESTART_INTENT_PURPOSE, {
    expiresAt: new Date(now.getTime() + RESTART_INTENT_TTL_MS),
  });
}
