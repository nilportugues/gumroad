// Port of app/sidekiq/recover_stranded_buyers_job.rb, up to the first stranded candidate: Risk::StrandedBuyerScanService's candidate
// emails (buyers whose newest checkouts failed on a platform block in the last 30 days, 20,000 at most), then per slice of 500 the
// settled-history counts (three paid purchases older than 60 days) and the dispute filter. A run where no candidate survives them
// has nothing stranded and finishes. The first buyer who survives needs the latest-failure reads, DecliningPlatformBlocks and the
// recovery service, so the run hands back there; nothing has been written (the scan only reads).
// Golden: __fixtures__/recover-stranded-buyers-job.golden.json (scripts/golden/recover-stranded-buyers-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { columnIn, selectRows } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FAILURE_LOOKBACK = { days: 30 };
const BLOCK_ERROR_CODES = ["blocked_browser_guid", "blocked_email_domain", "blocked_ip_address"];
const MAX_CANDIDATES_SCANNED = 20_000;
const HISTORY_COUNT_BATCH = 500;
const MIN_PURCHASE_AGE_FOR_CLEAN_HISTORY = { days: 60 };
const MIN_SUCCESSFUL_PURCHASES_FOR_CLEAN_HISTORY = 3;
const MS_PER_SECOND = 1000;

// purchases.created_at is datetime(0): ActiveRecord binds the bound without its fraction.
const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / MS_PER_SECOND) * MS_PER_SECOND);

// `Purchase.successful.non_free.not_fully_refunded.not_chargedback_or_chargedback_reversed.where(created_at: ..60.days.ago)
// .where(email: emails).group(:email).count`, keys downcased, kept at three or more.
async function settledPurchaseCounts(emails: string[], now: Date): Promise<string[]> {
  const rows = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT COUNT(*) AS \`count_all\`, \`purchases\`.\`email\` AS \`purchases_email\` FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'successful' AND (purchases.price_cents != 0) AND (purchases.stripe_refunded IS NULL OR purchases.stripe_refunded = 0) AND (purchases.chargeback_date IS NULL OR (purchases.chargeback_date IS NOT NULL AND purchases.flags & '512' != 0)) AND \`purchases\`.\`created_at\` <= ${wholeSeconds(ago(MIN_PURCHASE_AGE_FOR_CLEAN_HISTORY, now))} AND ${columnIn("purchases", "email", emails)} GROUP BY \`purchases\`.\`email\``,
  );
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row.purchases_email).toLowerCase(), Number(row.count_all));
  return [...counts].filter(([, count]) => count >= MIN_SUCCESSFUL_PURCHASES_FOR_CLEAN_HISTORY).map(([email]) => email);
}

// `Purchase.excluding_paypal_processor.where(email:).where.not(chargeback_date: nil).where("flags & chargeback_reversed = 0")
// .distinct.pluck(:email)`: buyers with a dispute still standing.
async function disputedEmails(emails: string[]): Promise<Set<string>> {
  const rows = await selectRows<{ email: string }>(
    Prisma.sql`SELECT DISTINCT \`purchases\`.\`email\` FROM \`purchases\` WHERE (COALESCE(purchases.charge_processor_id, '') != 'paypal') AND ${columnIn("purchases", "email", emails)} AND \`purchases\`.\`chargeback_date\` IS NOT NULL AND (purchases.flags & '512' = 0)`,
  );
  return new Set(rows.map((row) => row.email.toLowerCase()));
}

export const recoverStrandedBuyersJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const now = deps.now();
  const candidateRows = await selectRows<{ email: string }>(
    Prisma.sql`SELECT \`purchases\`.\`email\` FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'failed' AND ${columnIn("purchases", "error_code", BLOCK_ERROR_CODES)} AND \`purchases\`.\`created_at\` >= ${wholeSeconds(ago(FAILURE_LOOKBACK, now))} AND \`purchases\`.\`email\` IS NOT NULL GROUP BY \`purchases\`.\`email\` ORDER BY MAX(purchases.created_at) DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
  );
  const candidates = candidateRows.slice(0, MAX_CANDIDATES_SCANNED).map((row) => row.email);

  for (let start = 0; start < candidates.length; start += HISTORY_COUNT_BATCH) {
    const settled = await settledPurchaseCounts(candidates.slice(start, start + HISTORY_COUNT_BATCH), now);
    if (settled.length === 0) continue;
    const disputed = await disputedEmails(settled);
    if (settled.some((email) => !disputed.has(email)))
      throw new HandBackToRuby("a stranded-buyer candidate needs the latest failures and DecliningPlatformBlocks");
  }
});

export const recoverStrandedBuyersJob = recoverStrandedBuyersJobWith();
