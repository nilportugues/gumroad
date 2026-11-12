// Create side of app/models/order.rb. `purchaser` is optional and the one callback is
// `after_save :schedule_review_reminder!, if: :should_schedule_review_reminder?`, which needs a cart. A cartless
// order only pays for the `carts` lookup; an order with a cart can schedule OrderReviewReminderJob and rewrite the
// row, which is not ported, so that save hands back.
import { Prisma, type Order } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";

import { defineModel } from "./runtime/define-model.ts";
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
