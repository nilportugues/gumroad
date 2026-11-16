// app/models/charge_purchase.rb: the join row, both belongs_to required.
import type { ChargePurchase } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const CHARGE_PURCHASES = "charge_purchases";

const CHARGE: BelongsTo = { name: "charge", foreignKey: "charge_id", targetTable: "charges", targetModel: "Charge" };
const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const ChargePurchases = defineModel<ChargePurchase>({
  rubyClass: "ChargePurchase",
  prismaModel: "ChargePurchase",
  delegate: (tx) => tx.chargePurchase as never,
  validations: [belongsToRequired<ChargePurchase>(CHARGE), belongsToRequired<ChargePurchase>(PURCHASE)],
});
