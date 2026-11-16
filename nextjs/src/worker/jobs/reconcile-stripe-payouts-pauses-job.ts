// Port of app/sidekiq/reconcile_stripe_payouts_pauses_job.rb: the sellers carrying a Stripe-source payout-pause comment, each queued once
// for ReconcileStripePayoutsPauseForSellerJob (which stays in Ruby; its enqueue is Sidekiq's format). `find_in_batches` over
// `select(:id, :commentable_id)`, with the replica-lag check once per batch.
// Golden: __fixtures__/reconcile-stripe-payouts-pauses-job.golden.json (scripts/golden/reconcile-stripe-payouts-pauses-job.rb).
import { Prisma } from "@prisma/client";

import { alive, COMMENT_TYPES, COMMENTS, withType } from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const BATCH_SIZE = 1_000;
// StripeMerchantAccountManager::STRIPE_PAYOUTS_SYNC_COMMENT_AUTHOR
const STRIPE_PAYOUTS_SYNC_COMMENT_AUTHOR = "Stripe payouts sync";

export const reconcileStripePayoutsPausesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const seen = new Set<string>();
  const where = Prisma.sql`${alive} AND ${withType(COMMENT_TYPES.PAYOUTS_PAUSED)} AND ${column(COMMENTS, "commentable_type")} = ${"User"} AND ${column(COMMENTS, "author_name")} = ${STRIPE_PAYOUTS_SYNC_COMMENT_AUTHOR}`;
  let after: unknown = null;
  for (;;) {
    const rows = await selectRows<{ id: unknown; commentable_id: bigint | number }>(
      Prisma.sql`SELECT ${column(COMMENTS, "id")}, ${column(COMMENTS, "commentable_id")} FROM ${table(COMMENTS)} WHERE ${where}${
        after === null ? Prisma.empty : Prisma.sql` AND ${column(COMMENTS, "id")} > ${after}`
      } ORDER BY ${column(COMMENTS, "id")} ASC LIMIT ${Prisma.raw(String(BATCH_SIZE))}`,
    );
    if (rows.length === 0) return;
    await deps.watchReplicaLag();
    for (const row of rows) {
      const key = String(row.commentable_id);
      if (seen.has(key)) continue;
      seen.add(key);
      await performAsync("ReconcileStripePayoutsPauseForSellerJob", [row.commentable_id]);
    }
    if (rows.length < BATCH_SIZE) return;
    after = rows.at(-1)!.id;
  }
});

export const reconcileStripePayoutsPausesJob = reconcileStripePayoutsPausesJobWith();
