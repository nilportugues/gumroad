// Port of app/sidekiq/record_order_charge_outcome_job.rb and Order#record_charge_outcome!: an order with a line item served at
// checkout and another that failed is flagged partially_successful. Sibling states are read from the primary because the line item
// that enqueued this has only just committed. Golden: __fixtures__/record-order-charge-outcome-job.golden.json
// (scripts/golden/record-order-charge-outcome-job.rb).
import { Prisma, type Order } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { connectedTo } from "../../server/models/runtime/query-cache.ts";
import { column, columnIn, execute, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const ORDERS = "orders";
const PURCHASES = "purchases";
const ORDER_PURCHASES = "order_purchases";
// Order flag 2 (partially_successful); flag_shih_tzu numbers bits from 1.
const PARTIALLY_SUCCESSFUL = 1 << 1;
// Purchase::CHECKOUT_SUCCESS_STATES: both concluded-preorder states count, though one is a later failure.
const CHECKOUT_SUCCESS_STATES = [
  "preorder_authorization_successful",
  "successful",
  "not_charged",
  "gift_receiver_purchase_successful",
  "preorder_concluded_successfully",
  "preorder_concluded_unsuccessfully",
];
// Purchase::CHECKOUT_FAILURE_STATES
const CHECKOUT_FAILURE_STATES = ["failed", "preorder_authorization_failed", "gift_receiver_purchase_failed"];

// `order.purchases.<scope>.exists?`
const orderHasPurchaseIn = async (orderId: bigint | number, states: string[]) =>
  (
    await selectRows(
      Prisma.sql`SELECT 1 AS one FROM ${table(PURCHASES)} INNER JOIN ${table(ORDER_PURCHASES)} ON ${column(PURCHASES, "id")} = ${column(ORDER_PURCHASES, "purchase_id")} WHERE ${column(ORDER_PURCHASES, "order_id")} = ${orderId} AND ${columnIn(PURCHASES, "purchase_state", states)} LIMIT 1`,
    )
  ).length > 0;

export const recordOrderChargeOutcomeJobWith = modelJob({ min: 1 }, async ([orderId], deps) => {
  const key = orderId === null ? null : await beforeSideEffects(() => recordIdFrom(orderId, "Order.find_by"));
  await connectedTo("writing", async () => {
    const order = await findOneBy<Order>("Order", "id", key, true);
    if (order === null) return;
    if ((Number(order.flags) & PARTIALLY_SUCCESSFUL) !== 0) return;
    if (!(await orderHasPurchaseIn(order.id, CHECKOUT_SUCCESS_STATES))) return;
    if (!(await orderHasPurchaseIn(order.id, CHECKOUT_FAILURE_STATES))) return;

    await execute(
      Prisma.sql`UPDATE ${table(ORDERS)} SET flags = flags | ${Prisma.raw(String(PARTIALLY_SUCCESSFUL))}, updated_at = ${deps.now()} WHERE ${column(ORDERS, "id")} = ${order.id}`,
    );
  });
});

export const recordOrderChargeOutcomeJob = recordOrderChargeOutcomeJobWith();
