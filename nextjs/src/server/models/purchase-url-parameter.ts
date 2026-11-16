// app/models/purchase_url_parameter.rb: the query parameters of the product URL at checkout, minus the reserved ones, which
// the sale ping hands back as `url_params`. belongs_to :purchase (required), validates :params, presence.
import type { PurchaseUrlParameter } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";

export const PURCHASE_URL_PARAMETERS = "purchase_url_parameters";

const PURCHASE: BelongsTo = {
  name: "purchase",
  foreignKey: "purchase_id",
  targetTable: "purchases",
  targetModel: "Purchase",
};

export const PurchaseUrlParameters = defineModel<PurchaseUrlParameter>({
  rubyClass: "PurchaseUrlParameter",
  prismaModel: "PurchaseUrlParameter",
  delegate: (tx) => tx.purchaseUrlParameter as never,
  validations: [
    belongsToRequired<PurchaseUrlParameter>(PURCHASE),
    validatesPresenceOf<PurchaseUrlParameter>(["params"]),
  ],
});
