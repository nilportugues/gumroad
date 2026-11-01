// Port of app/models/large_seller.rb.
import { Prisma, type LargeSeller } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, selectRows, table } from "./sql.ts";

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

// `LargeSeller.where(user:).exists?`
export async function isLargeSeller(userId: bigint | number): Promise<boolean> {
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(LARGE_SELLERS)} WHERE ${column(LARGE_SELLERS, "user_id")} = ${userId} LIMIT 1`);
  return rows.length > 0;
}

// `LargeSeller.create_if_warranted(user)`: a seller with SALES_LOWER_LIMIT purchase rows of any kind
// (free ones count) gets a row, once; the row is never refreshed here.
export async function createLargeSellerIfWarranted(userId: bigint | number, now: () => Date = () => new Date()): Promise<void> {
  if (await isLargeSeller(userId)) return;
  const [row] = await selectRows<Record<string, bigint | number>>(salesCountSql(userId));
  const salesCount = Number(row ? Object.values(row)[0] : 0);
  if (salesCount < SALES_LOWER_LIMIT) return;
  await transaction(() => LargeSellers.createBang({ user_id: Number(userId), sales_count: salesCount }, { now }));
}
