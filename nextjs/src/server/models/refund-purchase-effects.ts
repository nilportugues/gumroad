// What refund_purchase! (app/modules/purchase/refundable.rb) does to a sale's other purchases: `mark_giftee_purchase_as_refunded` and
// `mark_product_purchases_as_refunded!` (app/models/purchase.rb). Each saves another Purchase through its validations and callbacks,
// so the Purchase save pipeline does that work; these find the rows and set the flag, in the order Ruby queries them.
// Golden: __fixtures__/refund-purchase-body.golden.json (scripts/golden/refund-purchase-body.rb).
import { Prisma, type Gift, type Purchase } from "@prisma/client";

import { associationCache } from "./concerns/rails-validations.ts";
import { Purchases, withContext, type PurchaseContext, type PurchaseRecord } from "./purchase-create.ts";
import { loadLinkAssociations, markAssociationsReloaded } from "./purchase-reloaded-associations.ts";
import { holdGiftGiven, type HeldGiftGiven } from "./refund-held-associations.ts";
import type { SaveOptions } from "./runtime/define-model.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const notPorted = (what: string) =>
  new NotPortedError(`Purchase#refund_purchase! with ${what}`, "app/models/purchase.rb:2388");

// Another purchase of the same product and seller, loaded as `gift_given.giftee_purchase` or `product_purchases` load it: its
// seller and link are read again at its first save, so they are marked stale here.
export function siblingRecord(row: Purchase, of: PurchaseRecord): PurchaseRecord {
  if (row.link_id !== of.get("link_id") || row.seller_id !== of.get("seller_id"))
    throw notPorted("a purchase of another product or seller");
  const record = withContext(Purchases.load(row), of.ivars.context as PurchaseContext);
  // withContext seeds the link and seller; a purchase Rails loaded fresh has neither
  associationCache(record).clear();
  markAssociationsReloaded(record);
  return record;
}

async function markRefunded(record: PurchaseRecord, isPartiallyRefunded: boolean, options: SaveOptions): Promise<void> {
  record.set(isPartiallyRefunded ? "stripe_partially_refunded" : "stripe_refunded", true);
  await loadLinkAssociations(record);
  await Purchases.saveBang(record, options);
}

// Purchase#mark_giftee_purchase_as_refunded
export async function markGifteePurchaseAsRefundedBang(
  purchase: PurchaseRecord,
  isPartiallyRefunded: boolean,
  options: SaveOptions = {},
): Promise<void> {
  const [gift] = await selectRows<Gift>(
    Prisma.sql`SELECT ${Prisma.raw("`gifts`.*")} FROM ${table("gifts")} WHERE ${column("gifts", "gifter_purchase_id")} = ${purchase.get("id")} LIMIT 1`,
  );
  // `gift_given` stays loaded on the sender, so its later saves resolve the review through the giftee without a query
  const held: HeldGiftGiven = { giftee: null };
  holdGiftGiven(purchase, held);
  if (gift === undefined) return;
  // no golden has a gift row without a recipient purchase
  if (gift.giftee_purchase_id === null) throw notPorted("a gift without a recipient purchase");
  const [row] = await selectRows<Purchase>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${gift.giftee_purchase_id} LIMIT 1`,
  );
  if (row === undefined) return;
  held.giftee = siblingRecord(castRow<Purchase>("Purchase", row), purchase);
  await markRefunded(held.giftee, isPartiallyRefunded, options);
}

// Purchase#mark_product_purchases_as_refunded!, after `return unless is_bundle_purchase?`
export async function markProductPurchasesAsRefundedBang(
  purchase: PurchaseRecord,
  isPartiallyRefunded: boolean,
  options: SaveOptions = {},
): Promise<void> {
  const rows = await selectRows<Purchase>(
    Prisma.sql`SELECT ${Prisma.raw("`purchases`.*")} FROM ${table("purchases")} INNER JOIN ${table("bundle_product_purchases")} ON ${column("purchases", "id")} = ${column("bundle_product_purchases", "product_purchase_id")} WHERE ${column("bundle_product_purchases", "bundle_purchase_id")} = ${purchase.get("id")}`,
  );
  for (const row of rows)
    await markRefunded(siblingRecord(castRow<Purchase>("Purchase", row), purchase), isPartiallyRefunded, options);
}
