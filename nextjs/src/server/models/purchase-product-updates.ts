// Port of Purchase.preload_product_updates_data! (app/models/purchase.rb): the `product_updates_data` a purchase exposes in mobile JSON.
//
// Ported: the blocked-subscription guard (a lapsed membership whose product blocks access after cancellation sees no posts, whatever the
// seller has posted) and the case where there is nothing to show because neither the seller nor the product has any post. Any other
// purchase needs Purchase.product_installments (buyer filters, email infos, workflows) and Installment#installment_mobile_json_data
// (which creates url redirects), neither ported, so the whole batch is Rails'.
import { Prisma, type Purchase } from "@prisma/client";

import { NotPortedError } from "../page-props/not-ported.ts";

import { LinkFlags } from "./link.ts";
import { column, selectRows, table } from "./sql.ts";

// An entry of Installment#installment_mobile_json_data; none is serialized yet.
export type ProductUpdate = Record<string, unknown>;

type PurchaseRef = Pick<Purchase, "id" | "link_id" | "seller_id" | "subscription_id">;
type SubscriptionRow = { id: bigint; failed_at: Date | null; ended_at: Date | null; cancelled_at: Date | null };

// Subscription#alive? with include_pending_cancellation: true
const subscriptionAlive = (subscription: SubscriptionRow, now: Date): boolean => {
  if (subscription.failed_at !== null || subscription.ended_at !== null) return false;
  return subscription.cancelled_at === null || subscription.cancelled_at > now;
};

async function subscriptionsById(ids: bigint[]): Promise<Map<bigint, SubscriptionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await selectRows<SubscriptionRow>(
    Prisma.sql`SELECT ${column("subscriptions", "id")}, ${column("subscriptions", "failed_at")}, ${column("subscriptions", "ended_at")}, ${column("subscriptions", "cancelled_at")} FROM ${table("subscriptions")} WHERE ${column("subscriptions", "id")} IN (${Prisma.join(ids)})`,
  );
  return new Map(rows.map((row) => [BigInt(row.id), row]));
}

async function blockingFlagsByProduct(productIds: bigint[]): Promise<Map<bigint, boolean>> {
  const rows = await selectRows<{ id: bigint; flags: bigint | number }>(
    Prisma.sql`SELECT ${column("links", "id")}, ${column("links", "flags")} FROM ${table("links")} WHERE ${column("links", "id")} IN (${Prisma.join(productIds)})`,
  );
  return new Map(
    rows.map((row) => [
      BigInt(row.id),
      LinkFlags.isSet(BigInt(row.flags), "block_access_after_membership_cancellation"),
    ]),
  );
}

// Every scope of Purchase.product_installments is `alive.published`, so a draft or a deleted post never reaches a buyer.
async function anyPostBy(sellerIds: bigint[], productIds: bigint[]): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT 1 FROM ${table("installments")} WHERE (${column("installments", "seller_id")} IN (${Prisma.join(sellerIds)}) OR ${column("installments", "link_id")} IN (${Prisma.join(productIds)})) AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "published_at")} IS NOT NULL LIMIT 1`,
  );
  return rows.length > 0;
}

// Keyed by purchase id. Throws NotPortedError when a purchase may have posts to show.
export async function preloadProductUpdatesData(
  purchases: PurchaseRef[],
  now: Date = new Date(),
): Promise<Map<bigint, ProductUpdate[]>> {
  const updates = new Map<bigint, ProductUpdate[]>();
  if (purchases.length === 0) return updates;

  const productIds = [...new Set(purchases.map((purchase) => purchase.link_id))];
  if (productIds.some((id) => id === null)) throw new NotPortedError("a purchase without a product");
  const subscriptions = await subscriptionsById([
    ...new Set(purchases.flatMap((purchase) => (purchase.subscription_id === null ? [] : [purchase.subscription_id]))),
  ]);
  const blocking = await blockingFlagsByProduct(productIds as bigint[]);

  const open: PurchaseRef[] = [];
  for (const purchase of purchases) {
    const subscription = purchase.subscription_id === null ? undefined : subscriptions.get(purchase.subscription_id);
    const product = blocking.get(purchase.link_id!);
    if (product === undefined) throw new NotPortedError("a purchase whose product row is missing");
    if (purchase.subscription_id !== null && subscription === undefined)
      throw new NotPortedError("a purchase whose subscription row is missing");
    if (subscription !== undefined && !subscriptionAlive(subscription, now) && product) updates.set(purchase.id, []);
    else open.push(purchase);
  }
  if (open.length === 0) return updates;

  const sellerIds = [...new Set(open.map((purchase) => purchase.seller_id))];
  if (sellerIds.some((id) => id === null)) throw new NotPortedError("a purchase without a seller");
  if (await anyPostBy(sellerIds as bigint[], [...new Set(open.map((purchase) => purchase.link_id!))]))
    throw new NotPortedError("Purchase.product_installments for a seller or product with posts");
  for (const purchase of open) updates.set(purchase.id, []);
  return updates;
}
