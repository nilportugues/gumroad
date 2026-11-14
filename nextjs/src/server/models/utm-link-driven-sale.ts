// app/models/utm_link_driven_sale.rb: three required belongs_to and the purchase-per-visit uniqueness.
import type { UtmLinkDrivenSale } from "@prisma/client";

import { belongsToRequired, validatesUniqueness } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { UTM_LINK } from "./utm-link-visit.ts";

export const UTM_LINK_DRIVEN_SALES = "utm_link_driven_sales";

export const UtmLinkDrivenSales = defineModel<UtmLinkDrivenSale>({
  rubyClass: "UtmLinkDrivenSale",
  prismaModel: "UtmLinkDrivenSale",
  delegate: (tx) => tx.utmLinkDrivenSale as never,
  validations: [
    belongsToRequired<UtmLinkDrivenSale>(UTM_LINK),
    belongsToRequired<UtmLinkDrivenSale>({
      name: "utm_link_visit",
      foreignKey: "utm_link_visit_id",
      targetTable: "utm_link_visits",
      targetModel: "UtmLinkVisit",
    }),
    belongsToRequired<UtmLinkDrivenSale>({
      name: "purchase",
      foreignKey: "purchase_id",
      targetTable: "purchases",
      targetModel: "Purchase",
    }),
    validatesUniqueness<UtmLinkDrivenSale>("UtmLinkDrivenSale", UTM_LINK_DRIVEN_SALES, "purchase_id", {
      scope: ["utm_link_visit_id"],
    }),
  ],
});
