// app/models/purchase_sales_tax_info.rb: `belongs_to :purchase, optional: true` and nothing else; the table has no timestamps.
import type { PurchaseSalesTaxInfo } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";

export const PURCHASE_SALES_TAX_INFOS = "purchase_sales_tax_infos";

export const PurchaseSalesTaxInfos = defineModel<PurchaseSalesTaxInfo>({
  rubyClass: "PurchaseSalesTaxInfo",
  prismaModel: "PurchaseSalesTaxInfo",
  delegate: (tx) => tx.purchaseSalesTaxInfo as never,
});
