// Associations of a purchase that refund_purchase! loads and Rails keeps on the instance, so the purchase's later saves read them
// without a query. Kept apart from the modules that load them because the Purchase save pipeline reads them too.
import type { PurchaseRecord } from "./purchase-create.ts";
import type { SubscriptionModel } from "./subscription-writes.ts";

const SUBSCRIPTION = "heldSubscription";
const GIFT_GIVEN = "heldGiftGiven";

// `purchase.subscription` (null: loaded and absent)
export type HeldSubscription = { subscription: SubscriptionModel | null };
export const holdSubscription = (purchase: PurchaseRecord, held: HeldSubscription): void => {
  purchase.ivars[SUBSCRIPTION] = held;
};
export const heldSubscription = (purchase: PurchaseRecord): HeldSubscription | undefined =>
  purchase.ivars[SUBSCRIPTION] as HeldSubscription | undefined;

// `purchase.gift_given&.giftee_purchase` (null: none)
export type HeldGiftGiven = { giftee: PurchaseRecord | null };
export const holdGiftGiven = (purchase: PurchaseRecord, held: HeldGiftGiven): void => {
  purchase.ivars[GIFT_GIVEN] = held;
};
export const heldGiftGiven = (purchase: PurchaseRecord): HeldGiftGiven | undefined =>
  purchase.ivars[GIFT_GIVEN] as HeldGiftGiven | undefined;
