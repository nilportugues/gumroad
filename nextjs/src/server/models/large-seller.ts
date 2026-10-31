// Port of app/models/large_seller.rb. Not ported: LargeSeller.create_if_warranted (takes a User).
import { Prisma, type LargeSeller } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { column, table } from "./sql.ts";

export const LARGE_SELLERS = "large_sellers";
export const SALES_LOWER_LIMIT = 1000;

// belongs_to :user, optional: true, so saves never load the user.
export const LargeSellers = defineModel<LargeSeller>({
  rubyClass: "LargeSeller",
  prismaModel: "LargeSeller",
  delegate: (tx) => tx.largeSeller as never,
});

// `user.sales.count`
export const salesCountSql = (userId: unknown) => Prisma.sql`SELECT COUNT(*) FROM ${table("purchases")} WHERE ${column("purchases", "seller_id")} = ${userId}`;
