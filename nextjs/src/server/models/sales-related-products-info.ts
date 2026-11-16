// Port of the parts of app/models/sales_related_products_info.rb the related-products jobs write: the Purchase scope they count and
// `update_sales_counts`, one INSERT ... ON DUPLICATE KEY UPDATE per slice of pairs, each in its own READ COMMITTED transaction and
// retried on a deadlock or lock wait timeout.
import { Prisma } from "@prisma/client";

import { currentTransaction, transaction } from "./runtime/transaction.ts";
import { execute, isDeadlocked, isLockWaitTimeout, quoteName } from "./sql.ts";

const PURCHASES = "purchases";
const SALES_COUNT_UPSERT_BATCH_SIZE = 100;
const UPSERT_CONTENTION_RETRIES = 3;
const UPSERT_CONTENTION_BASE_BACKOFF = 0.05;
// Purchase.flag_mapping["flags"]: chargeback_reversed and is_gift_receiver_purchase
const CHARGEBACK_REVERSED = 512;
const IS_GIFT_RECEIVER_PURCHASE = 32;

// `Purchase.successful_or_preorder_authorization_successful_and_not_refunded_or_chargedback`, as Rails writes it
// (the chargeback flag bit is quoted by the `where` string's bind, the gift receiver bit is Arel's).
export const COUNTED_PURCHASES = Prisma.raw(
  `${quoteName(PURCHASES)}.${quoteName("purchase_state")} IN ('successful', 'preorder_authorization_successful', 'gift_receiver_purchase_successful') AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '${CHARGEBACK_REVERSED}' != 0)) AND ((${quoteName(PURCHASES)}.${quoteName("flags")} & ${IS_GIFT_RECEIVER_PURCHASE} = 0))`,
);

export type SalesCountDeps = {
  now: () => Date;
  // Kernel.rand with no argument
  random: () => number;
  sleep: (seconds: number) => Promise<void>;
};

// `Time.current.to_fs(:db)`, quoted with double quotes
const quotedDb = (time: Date) => `"${time.toISOString().slice(0, 19).replace("T", " ")}"`;

// Retries are per statement; a deadlock rolls the statement's own transaction back whole, so nothing is counted twice.
async function upsertWithContentionRetry(query: string, deps: SalesCountDeps): Promise<void> {
  // Inside a caller's transaction a deadlock would roll the caller back, so Rails runs the statement once, without retrying.
  if (currentTransaction() !== null) {
    await execute(Prisma.raw(query));
    return;
  }
  for (let attempts = 1; ; attempts += 1) {
    try {
      await transaction(() => execute(Prisma.raw(query)), { isolation: "read_committed" });
      return;
    } catch (error) {
      if (!(isDeadlocked(error) || isLockWaitTimeout(error)) || attempts > UPSERT_CONTENTION_RETRIES) throw error;
      await deps.sleep(UPSERT_CONTENTION_BASE_BACKOFF * 2 ** (attempts - 1) * (0.5 + deps.random()));
    }
  }
}

// `SalesRelatedProductsInfo.update_sales_counts(product_id:, related_product_ids:, increment:)`
export async function updateSalesCounts(
  productId: bigint,
  relatedProductIds: bigint[],
  increment: boolean,
  deps: SalesCountDeps,
): Promise<void> {
  const pairProductIds = [...new Set(relatedProductIds)].filter((id) => id !== productId);
  if (pairProductIds.length === 0) return;

  const now = quotedDb(deps.now());
  const salesCountChange = increment ? 1 : -1;
  // A pair seen for the first time starts at 1 for a sale, and at 0 for a reversal, which had no counted sale to take away.
  const newSalesCount = increment ? 1 : 0;

  // Sorted so overlapping statements take their row locks in the same order.
  const pairs = pairProductIds
    .map((id) => (productId < id ? [productId, id] : [id, productId]) as [bigint, bigint])
    .sort(([a1, b1], [a2, b2]) => (a1 === a2 ? (b1 < b2 ? -1 : b1 > b2 ? 1 : 0) : a1 < a2 ? -1 : 1));

  for (let start = 0; start < pairs.length; start += SALES_COUNT_UPSERT_BATCH_SIZE) {
    const values = pairs
      .slice(start, start + SALES_COUNT_UPSERT_BATCH_SIZE)
      .map(([smaller, larger]) => `(${[smaller, larger, newSalesCount, now, now].join(", ")})`)
      .join(", ");
    await upsertWithContentionRetry(
      `INSERT INTO sales_related_products_infos (smaller_product_id, larger_product_id, sales_count, created_at, updated_at)\nVALUES ${values}\nON DUPLICATE KEY UPDATE sales_count = sales_count + (${salesCountChange}), updated_at = ${now};\n`,
      deps,
    );
  }
}
