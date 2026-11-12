// app/models/order_purchase.rb: both sides required, as belongs_to and again as validates_presence_of.
import type { OrderPurchase } from "@prisma/client";

import { belongsToRequired, type BelongsTo, validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const ORDER_PURCHASES = "order_purchases";

const ORDER: BelongsTo = { name: "order", foreignKey: "order_id", targetTable: "orders", targetModel: "Order" };
const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const OrderPurchases = defineModel<OrderPurchase>({
  rubyClass: "OrderPurchase",
  prismaModel: "OrderPurchase",
  delegate: (tx) => tx.orderPurchase as never,
  validations: [
    belongsToRequired<OrderPurchase>(ORDER),
    belongsToRequired<OrderPurchase>(PURCHASE),
    validatesAssociationPresence<OrderPurchase>(ORDER),
    validatesAssociationPresence<OrderPurchase>(PURCHASE),
  ],
});
