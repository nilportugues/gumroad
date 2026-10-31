// Ports of the jobs whose only model write is a Comment:
// app/sidekiq/content_moderation_admin_comment_job.rb and
// app/sidekiq/release_chargeback_rate_payout_pauses_job.rb.
import { Prisma } from "@prisma/client";

import {
  alive,
  COMMENT_TYPES,
  COMMENTS,
  commentsOf,
  Comments,
  CONTENT_MODERATION_ADMIN_COMMENT_DEDUP_WINDOW,
  CONTENT_MODERATION_AUTHOR_NAME,
  withType,
} from "../../server/models/comment.ts";
import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { column, selectRows, table } from "../../server/models/sql.ts";
import { modelJob } from "./support/job-deps.ts";

// User::SYSTEM_PAYOUT_PAUSE_COMMENT_AUTHORS[:high_chargeback_rate] (app/modules/user/risk.rb).
export const HIGH_CHARGEBACK_RATE_PAUSE_AUTHOR = "pause_payouts_for_seller_based_on_chargeback_rate";
const RELEASE_BATCH_SIZE = 1_000;

export const contentModerationAdminCommentJobWith = modelJob({ min: 2 }, async ([userId, content], deps) => {
  const [user] = await selectRows<{ id: unknown }>(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
  if (!user) return;

  // A seller retrying a blocked publish re-triggers the moderation check.
  const since = ago(CONTENT_MODERATION_ADMIN_COMMENT_DEDUP_WINDOW, deps.now());
  const duplicates = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(COMMENTS)} WHERE ${commentsOf("User", user.id)} AND ${withType(COMMENT_TYPES.NOTE)} AND ${column(COMMENTS, "author_name")} = ${CONTENT_MODERATION_AUTHOR_NAME} AND ${column(COMMENTS, "content")} = ${content} AND (created_at > ${since}) LIMIT 1`,
  );
  if (duplicates.length > 0) return;

  await Comments.createBang(
    { commentable_id: user.id as bigint, commentable_type: "User", author_name: CONTENT_MODERATION_AUTHOR_NAME, comment_type: COMMENT_TYPES.NOTE, content: content as string },
    { now: deps.now },
  );
});

// `find_in_batches` over `select(:id, :commentable_id)`.
export const releaseChargebackRatePayoutPausesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const seen = new Set<string>();
  const where = Prisma.sql`${alive} AND ${withType(COMMENT_TYPES.ON_PROBATION)} AND ${column(COMMENTS, "commentable_type")} = ${"User"} AND ${column(COMMENTS, "author_name")} = ${HIGH_CHARGEBACK_RATE_PAUSE_AUTHOR}`;
  let after: unknown = null;
  for (;;) {
    const rows = await selectRows<{ id: unknown; commentable_id: bigint | number }>(
      Prisma.sql`SELECT ${column(COMMENTS, "id")}, ${column(COMMENTS, "commentable_id")} FROM ${table(COMMENTS)} WHERE ${where}${
        after === null ? Prisma.empty : Prisma.sql` AND ${column(COMMENTS, "id")} > ${after}`
      } ORDER BY ${column(COMMENTS, "id")} ASC LIMIT ${Prisma.raw(String(RELEASE_BATCH_SIZE))}`,
    );
    if (rows.length === 0) return;
    await deps.watchReplicaLag();
    for (const row of rows) {
      const key = String(row.commentable_id);
      if (seen.has(key)) continue;
      seen.add(key);
      await performAsync("ReleaseChargebackRatePayoutPauseForSellerJob", [row.commentable_id]);
    }
    if (rows.length < RELEASE_BATCH_SIZE) return;
    after = rows.at(-1)!.id;
  }
});

export const contentModerationAdminCommentJob = contentModerationAdminCommentJobWith();
export const releaseChargebackRatePayoutPausesJob = releaseChargebackRatePayoutPausesJobWith();
