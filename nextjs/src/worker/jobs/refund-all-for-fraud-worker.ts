// Port of app/sidekiq/refund_all_for_fraud_worker.rb: queues one RefundPurchaseForFraudWorker per refundable sale of a suspended
// seller (the refunds themselves stay in Ruby) and leaves the admin's comment. `block_buyers` is passed on as received.
// Golden: __fixtures__/refund-all-for-fraud-worker.golden.json (scripts/golden/refund-all-for-fraud-worker.rb).
import { Prisma } from "@prisma/client";

import { beforeSideEffects } from "../../server/jobs/hand-back.ts";
import type { JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { COMMENT_TYPES, Comments } from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { recordIdFrom } from "../../server/models/row-reads.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { findUserBang, isSuspended, nameOrUsername } from "../../server/models/user.ts";

import { modelJob } from "./support/job-deps.ts";

const REFUND_PURCHASE_FOR_FRAUD_WORKER = "RefundPurchaseForFraudWorker";
const CHARGEBACK_REVERSED_FLAG = 512;

// `RefundAllForFraudWorker.refundable_purchases_for(user).ids`
async function refundablePurchaseIds(userId: unknown): Promise<unknown[]> {
  const p = (name: string) => column("purchases", name);
  const rows = await selectRows<{ id: unknown }>(
    Prisma.sql`SELECT ${p("id")} FROM ${table("purchases")} WHERE ${p("seller_id")} = ${userId} AND ${p("purchase_state")} = ${"successful"} AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & ${String(CHARGEBACK_REVERSED_FLAG)} != 0))`,
  );
  return rows.map((row) => row.id);
}

export const refundAllForFraudWorkerWith = modelJob(
  { min: 2, max: 3 },
  async ([userIdArg, adminUserIdArg, blockBuyersArg], deps) => {
    const { userId, adminId } = await beforeSideEffects(() => ({
      userId: recordIdFrom(userIdArg, "User.find"),
      adminId: recordIdFrom(adminUserIdArg, "User.find"),
    }));
    const user = await findUserBang(userId);
    if (!isSuspended(user)) return;

    // Ruby's default for an omitted argument; an explicit nil stays nil.
    const blockBuyers = blockBuyersArg === undefined ? false : blockBuyersArg;
    const purchaseIds = await refundablePurchaseIds(user.get("id"));
    for (const purchaseId of purchaseIds) {
      await performAsync(REFUND_PURCHASE_FOR_FRAUD_WORKER, [
        Number(purchaseId),
        adminUserIdArg as JsonValue,
        blockBuyers,
      ]);
    }

    const admin = await findUserBang(adminId);
    const adminName = nameOrUsername(admin);
    const count = purchaseIds.length;
    const buyers =
      blockBuyers === null || blockBuyers === false ? "buyers will not be blocked" : "buyers will be blocked";
    await Comments.createBang(
      {
        commentable_id: BigInt(user.get("id")),
        commentable_type: "User",
        author_id: BigInt(admin.get("id")),
        author_name: adminName,
        comment_type: COMMENT_TYPES.REFUND_ALL_FOR_FRAUD,
        content: `Bulk fraud refund initiated by ${adminName ?? ""}: ${count} ${count === 1 ? "purchase" : "purchases"} queued for refund, ${buyers}.`,
      },
      { now: deps.now },
    );
  },
);

export const refundAllForFraudWorker = refundAllForFraudWorkerWith();
