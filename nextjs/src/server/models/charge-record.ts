// Create side of app/models/charge.rb (charge.ts holds its reads). Charge declares no callbacks of its own; a create
// validates the two required belongs_to, order then seller. merchant_account and credit_card are optional.
import type { Charge } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const CHARGES = "charges";

export const ChargeFlags = defineFlags(
  CHARGES,
  { 1: "receipt_sent", 2: "client_confirmed" },
  { queryMode: "bit_operator" },
);

const ORDER: BelongsTo = { name: "order", foreignKey: "order_id", targetTable: "orders", targetModel: "Order" };
const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };

export const Charges = defineModel<Charge>({
  rubyClass: "Charge",
  prismaModel: "Charge",
  delegate: (tx) => tx.charge as never,
  validations: [belongsToRequired<Charge>(ORDER), belongsToRequired<Charge>(SELLER)],
});
