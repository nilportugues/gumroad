// Port of app/sidekiq/alert_on_stalled_post_email_blasts_job.rb up to the Sidekiq set scans: the abandoned-blast expiry
// (PostEmailBlast.expire, a double-checked update_all) and the candidate read. A run with no candidate finishes here. A run with
// candidates goes on to read Sidekiq's dead, retry, queued and busy sets, resolve each blast's action (which can enqueue
// SendPostBlastEmailsJob) and push the alert, so it hands back after the candidate read.
//
// The expiry has already been written by then, which Rails cannot tell apart from its own: the run it starts finds the same rows
// expired, `never_sent` no longer matches them, and its expiry does nothing. A failed expiry hands back too, since Rails reports
// that error and carries on to the scan.
// Golden: __fixtures__/alert-on-stalled-post-email-blasts-job.golden.json (scripts/golden/alert-on-stalled-post-email-blasts-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { columnIn, execute, column, selectRows, table } from "../../server/models/sql.ts";

import { type JobDeps, modelJob } from "./support/job-deps.ts";

const POST_EMAIL_BLASTS = "post_email_blasts";
const LOOKBACK = { days: 14 };
const DOUBLE_LOOKBACK = { days: 28 };
const STALL_THRESHOLD = { hours: 4 };
const MAX_CANDIDATES_SCANNED = 500;
// PostEmailBlast::EXPIRY_ABANDONED
const EXPIRY_ABANDONED = "abandoned";

const blasts = (name: string) => column(POST_EMAIL_BLASTS, name);
// where(completed_at: nil, expired_at: nil)
const EXPIRABLE_PENDING = Prisma.sql`${blasts("completed_at")} IS NULL AND ${blasts("expired_at")} IS NULL`;
const EXPIRABLE = Prisma.sql`${blasts("completed_at")} IS NULL AND ${blasts("expired_at")} IS NULL AND ${blasts("first_email_delivered_at")} IS NULL`;
// PostEmailBlast.never_sent: expirable, not a non-opener resend, and no sent_post_emails row since the blast was requested.
const NEVER_SENT = Prisma.sql`${EXPIRABLE} AND ${blasts("recipient_filter")} IS NULL AND (NOT EXISTS ( SELECT 1 FROM sent_post_emails WHERE sent_post_emails.post_id = post_email_blasts.post_id AND sent_post_emails.created_at >= post_email_blasts.requested_at AND sent_post_emails.created_at < COALESCE( (SELECT MIN(later.requested_at) FROM post_email_blasts later WHERE later.post_id = post_email_blasts.post_id AND later.recipient_filter IS NULL AND later.requested_at > post_email_blasts.requested_at), '9999-12-31')))`;

// PostEmailBlast.expire(ids, reason: EXPIRY_ABANDONED, never_sent: true)
async function expire(candidateIds: unknown[], now: Date): Promise<void> {
  // `where(id: [])` is a contradiction Rails answers without a query.
  if (candidateIds.length === 0) return;
  const ids = (
    await selectRows<{ id: unknown }>(
      Prisma.sql`SELECT ${blasts("id")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${NEVER_SENT} AND ${columnIn(POST_EMAIL_BLASTS, "id", candidateIds)}`,
    )
  ).map((row) => row.id);
  if (ids.length === 0) return;
  await execute(
    Prisma.sql`UPDATE ${table(POST_EMAIL_BLASTS)} SET ${blasts("expired_at")} = ${now}, ${blasts("expiry_reason")} = ${EXPIRY_ABANDONED}, ${blasts("updated_at")} = ${now} WHERE ${EXPIRABLE} AND ${columnIn(POST_EMAIL_BLASTS, "id", ids)}`,
  );
}

export const alertOnStalledPostEmailBlastsJobWith = (overrides: Partial<JobDeps> = {}) =>
  modelJob({ min: 0 }, async (_args, deps) => {
    const now = deps.now();
    try {
      const abandoned = await selectRows<{ id: unknown }>(
        Prisma.sql`SELECT ${blasts("id")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${NEVER_SENT} AND ${blasts("requested_at")} >= ${ago(DOUBLE_LOOKBACK, now)} AND ${blasts("requested_at")} < ${ago(LOOKBACK, now)} ORDER BY ${blasts("requested_at")} DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED))}`,
      );
      await expire(
        abandoned.map((row) => row.id),
        now,
      );
    } catch (error) {
      throw new HandBackToRuby(`the abandoned-blast expiry failed: ${(error as Error).message}`);
    }

    const candidates = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`post_email_blasts`.*")} FROM ${table(POST_EMAIL_BLASTS)} WHERE ${EXPIRABLE_PENDING} AND ${blasts("requested_at")} BETWEEN ${ago(LOOKBACK, now)} AND ${ago(STALL_THRESHOLD, now)} ORDER BY ${blasts("requested_at")} DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
    );
    if (candidates.length === 0) return;

    throw new HandBackToRuby("the stalled-blast scan reads Sidekiq's dead, retry, queued and busy sets");
  })(overrides);

export const alertOnStalledPostEmailBlastsJob = alertOnStalledPostEmailBlastsJobWith();
