// Port of app/sidekiq/regenerate_sales_related_products_infos_job.rb: rebuilds the product's SalesRelatedProductsInfo rows from the
// buyers who still own it. An argument that is not an Integer (a string id or limit, a float, null, a negative limit) is handed back
// before any statement: Ruby casts or fails on those in ways this port does not reproduce.
// Golden: __fixtures__/regenerate-sales-related-products-infos-job.golden.json (scripts/golden/regenerate-sales-related-products-infos-job.rb).
import { Prisma, type Link } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { findByIdBang } from "../../server/models/row-reads.ts";
import { column, columnIn, execute, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const PURCHASES = "purchases";
const INFOS = "sales_related_products_infos";
const DEFAULT_EMAIL_LIMIT = 5_000;
const DEFAULT_RELATIONSHIPS_LIMIT = 1_000;
const DEFAULT_INSERT_BATCH_SIZE = 10;
const IN_BATCHES_SIZE = 1_000;
// Purchase.flag_mapping["flags"]: chargeback_reversed and is_gift_receiver_purchase
const CHARGEBACK_REVERSED = 512;
const IS_GIFT_RECEIVER_PURCHASE = 32;

// `Purchase.successful_or_preorder_authorization_successful_and_not_refunded_or_chargedback`, as Rails writes it
// (the chargeback flag bit is quoted by the `where` string's bind, the gift receiver bit is Arel's).
const COUNTED_PURCHASES = Prisma.raw(
  `${quoteName(PURCHASES)}.${quoteName("purchase_state")} IN ('successful', 'preorder_authorization_successful', 'gift_receiver_purchase_successful') AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '${CHARGEBACK_REVERSED}' != 0)) AND ((${quoteName(PURCHASES)}.${quoteName("flags")} & ${IS_GIFT_RECEIVER_PURCHASE} = 0))`,
);

function integerArg(value: unknown, what: string, min: bigint): bigint {
  const integer =
    typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
  if (integer === null || integer < min)
    throw new HandBackToRuby(`${what} is not ${min === 0n ? "a non-negative" : "an"} Integer`);
  return integer;
}

export const regenerateSalesRelatedProductsInfosJobWith = modelJob({ min: 1, max: 4 }, async (args, deps) => {
  const productId = integerArg(args[0], "the product id", -(2n ** 63n));
  const emailLimit = integerArg(args[1] ?? DEFAULT_EMAIL_LIMIT, "the email limit", 0n);
  const relationshipsLimit = integerArg(args[2] ?? DEFAULT_RELATIONSHIPS_LIMIT, "the relationships limit", 0n);
  if (args[1] === null || args[2] === null) throw new HandBackToRuby("a null limit");
  const insertBatchSize = integerArg(args[3] ?? DEFAULT_INSERT_BATCH_SIZE, "the insert batch size", -(2n ** 63n));
  if (args[3] === null) throw new HandBackToRuby("a null insert batch size");

  await findByIdBang<Link>("Link", productId);

  const emailRows = await selectRows<{ email: string }>(
    Prisma.sql`SELECT DISTINCT ${column(PURCHASES, "email")} FROM ${table(PURCHASES)} WHERE ${COUNTED_PURCHASES} AND ${column(PURCHASES, "link_id")} = ${productId} AND ${column(PURCHASES, "email")} IS NOT NULL ORDER BY ${column(PURCHASES, "id")} DESC LIMIT ${Prisma.raw(String(emailLimit))}`,
  );
  const emails = emailRows.map((row) => row.email);

  // `where(email: [])` is a contradiction Rails answers without a query.
  const customerCounts =
    emails.length === 0
      ? []
      : await selectRows<{ link_id: bigint | number; customer_count: bigint | number }>(
          Prisma.sql`SELECT ${column(PURCHASES, "link_id")}, COUNT(DISTINCT(email)) as customer_count FROM ${table(PURCHASES)} WHERE ${COUNTED_PURCHASES} AND ${columnIn(PURCHASES, "email", emails)} AND ${column(PURCHASES, "link_id")} != ${productId} GROUP BY ${column(PURCHASES, "link_id")} ORDER BY ${Prisma.raw("`customer_count`")} DESC LIMIT ${Prisma.raw(String(relationshipsLimit))}`,
        );

  // `SalesRelatedProductsInfo.for_product_id(product.id).in_batches.delete_all`; the scope binds the id as a string.
  const forProduct = Prisma.sql`(smaller_product_id = ${String(productId)} OR larger_product_id = ${String(productId)})`;
  let after: unknown = null;
  for (;;) {
    const conditions = after === null ? forProduct : Prisma.sql`${forProduct} AND ${column(INFOS, "id")} > ${after}`;
    const ids = await selectRows<{ id: bigint | number }>(
      Prisma.sql`SELECT ${column(INFOS, "id")} FROM ${table(INFOS)} WHERE ${conditions} ORDER BY ${column(INFOS, "id")} ASC LIMIT ${Prisma.raw(String(IN_BATCHES_SIZE))}`,
    );
    if (ids.length === 0) break;
    const idList = ids.map((row) => row.id);
    const idCondition =
      idList.length === 1
        ? Prisma.sql`${column(INFOS, "id")} = ${idList[0]}`
        : Prisma.sql`${column(INFOS, "id")} IN (${Prisma.join(idList, ", ")})`;
    await execute(Prisma.sql`DELETE FROM ${table(INFOS)} WHERE ${forProduct} AND ${idCondition}`);
    if (ids.length < IN_BATCHES_SIZE) break;
    after = idList.at(-1);
  }

  // `each_slice` raises before it yields, even when there is nothing to insert.
  if (insertBatchSize <= 0n) throw new Error("invalid slice size");

  // `Time.current.to_fs(:db)`, quoted with double quotes
  const now = `"${deps.now().toISOString().slice(0, 19).replace("T", " ")}"`;
  const tuples = customerCounts.map((record) => {
    const other = BigInt(record.link_id);
    const [smaller, larger] = productId < other ? [productId, other] : [other, productId];
    return `(${[smaller, larger, record.customer_count, now, now].join(", ")})`;
  });
  const size = Number(insertBatchSize);
  for (let start = 0; start < tuples.length; start += size) {
    await execute(
      Prisma.raw(
        `INSERT IGNORE INTO ${INFOS}\n(smaller_product_id, larger_product_id, sales_count, created_at, updated_at)\nVALUES\n${tuples.slice(start, start + size).join(", ")};\n`,
      ),
    );
  }
});

export const regenerateSalesRelatedProductsInfosJob = regenerateSalesRelatedProductsInfosJobWith();
