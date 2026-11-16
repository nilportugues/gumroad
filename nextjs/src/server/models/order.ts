// Create side of app/models/order.rb. `purchaser` is optional and the one callback is
// `after_save :schedule_review_reminder!, if: :should_schedule_review_reminder?`, which needs a cart. A cartless
// order only pays for the `carts` lookup; an order with a cart can schedule OrderReviewReminderJob and rewrite the
// row, which is not ported, so that save hands back.
import { Prisma, type Order, type Purchase } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";

import { setAssociation } from "./concerns/rails-validations.ts";
import { OrderPurchases } from "./order-purchase.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { column, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const ORDERS = "orders";

export const OrderFlags = defineFlags(
  ORDERS,
  { 1: "DEPRECATED_seller_receipt_enabled", 2: "partially_successful" },
  { queryMode: "bit_operator" },
);

export const Orders = defineModel<Order>({
  rubyClass: "Order",
  prismaModel: "Order",
  delegate: (tx) => tx.order as never,
  afterSave: [
    {
      // has_many :purchases, through: :order_purchases autosaves what `order.purchases << purchase` appended, ahead of the
      // callbacks declared after the association.
      name: "autosave order_purchases",
      async run(record, { now }) {
        const appended = (record.ivars.appendedPurchases as ModelRecord<Purchase>[] | undefined) ?? [];
        record.ivars.appendedPurchases = [];
        for (const purchase of appended) {
          // Both sides are already loaded, so the presence validations send no query
          const link = OrderPurchases.build({ order_id: record.get("id"), purchase_id: purchase.get("id") } as never);
          setAssociation(link, "order", record.get("id"), record.attributes as never);
          setAssociation(link, "purchase", purchase.get("id"), purchase.attributes as never);
          await OrderPurchases.saveBang(link, { now });
        }
      },
    },
    {
      name: "schedule_review_reminder!",
      async run(record, { tx }) {
        if (record.get("review_reminder_scheduled_at") != null) return;
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT ${Prisma.raw("`carts`.*")} FROM ${table("carts")} WHERE ${column("carts", "order_id")} = ${record.get("id")} LIMIT 1`,
        );
        if (rows.length > 0) throw new NotPortedError("Order#schedule_review_reminder!", "an order with a cart");
      },
    },
  ],
});
