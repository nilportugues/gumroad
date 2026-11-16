// Port of app/sidekiq/backfill_pdf_stamps_job.rb up to the stamping: the product, one page of its stampable sales (newest first, 50 at
// a time, `includes(:url_redirect)` preloaded in one statement) and the chain's next page run in Node. A sale with a download page
// is stamped inline (`StampPdfForPurchaseJob.perform_inline` downloads, stamps and uploads a PDF), so a page holding one is handed back
// whole once the reads are done and nothing has been written; a page with none only walks on to the next one.
// Rails quotes the integers it binds into the SQL fragments as strings (`purchases.id < '30'`), and so does this.
// Golden: __fixtures__/backfill-pdf-stamps-job.golden.json (scripts/golden/backfill-pdf-stamps-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { findByIdBang, recordIdFrom } from "../../server/models/row-reads.ts";
import { columnIn, quoteName, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES_SECONDS = 60;
const SELF = "BackfillPdfStampsJob";
// Purchase.flag_mapping["flags"]: is_original_subscription_purchase, is_gift_receiver_purchase, is_gift_sender_purchase.
const ORIGINAL_SUBSCRIPTION_PURCHASE = 4;
const GIFT_RECEIVER_PURCHASE = 32;
const GIFT_SENDER_PURCHASE = 64;

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);

export const backfillPdfStampsJobWith = modelJob({ min: 1, max: 2 }, async ([productArg, beforeArg]) => {
  const { productId, before } = await beforeSideEffects(() => ({
    productId: recordIdFrom(productArg, "Link.find"),
    // A nil `before_purchase_id` adds no condition; any other value is bound as a quoted string.
    before: beforeArg === undefined || beforeArg === null ? null : recordIdFrom(beforeArg, "purchases.id < ?"),
  }));
  await findByIdBang("Link", productId);

  const beforeCondition = before === null ? Prisma.empty : Prisma.sql` AND (purchases.id < ${String(before)})`;
  const purchases = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${star("purchases")} FROM ${table("purchases")} WHERE ${columnIn("purchases", "link_id", [productId])} AND ${Prisma.raw("`purchases`.`purchase_state`")} IN ('successful', 'gift_receiver_purchase_successful') AND ((${Prisma.raw("`purchases`.`flags`")} & ${Prisma.raw(String(GIFT_SENDER_PURCHASE))} = 0)) AND (purchases.subscription_id IS NULL OR purchases.flags & ${String(ORIGINAL_SUBSCRIPTION_PURCHASE)} = ${String(ORIGINAL_SUBSCRIPTION_PURCHASE)} OR purchases.flags & ${String(GIFT_RECEIVER_PURCHASE)} = ${String(GIFT_RECEIVER_PURCHASE)})${beforeCondition} ORDER BY ${Prisma.raw("`purchases`.`id`")} DESC LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
  );

  if (purchases.length > 0) {
    const redirects = await selectRows<{ purchase_id: bigint | null }>(
      Prisma.sql`SELECT ${star("url_redirects")} FROM ${table("url_redirects")} WHERE ${columnIn(
        "url_redirects",
        "purchase_id",
        purchases.map((purchase) => purchase.id),
      )}`,
    );
    const stamped = new Set(redirects.map((redirect) => redirect.purchase_id));
    if (purchases.some((purchase) => stamped.has(purchase.id))) {
      throw new HandBackToRuby("StampPdfForPurchaseJob.perform_inline stamps the PDFs of a sale with a download page");
    }
  }

  if (purchases.length < BATCH_SIZE) return;
  await performAsync(SELF, [productId, purchases.at(-1)!.id], { delaySeconds: DELAY_BETWEEN_BATCHES_SECONDS });
});

export const backfillPdfStampsJob = backfillPdfStampsJobWith();
