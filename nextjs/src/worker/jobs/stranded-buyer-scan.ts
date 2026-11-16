// The candidate and settled-history legs of Risk::StrandedBuyerScanService (app/services/risk/stranded_buyer_scan_service.rb), shared by
// RecoverStrandedBuyersJob and AlertOnBlockedEstablishedBuyersJob. Everything past the first surviving buyer (the latest failures,
// DecliningPlatformBlocks) is not ported.
import { Prisma } from "@prisma/client";

import { ago } from "../../server/models/concerns/ruby-time.ts";
import { columnIn, selectRows } from "../../server/models/sql.ts";

const FAILURE_LOOKBACK = { days: 30 };
const BLOCK_ERROR_CODES = ["blocked_browser_guid", "blocked_email_domain", "blocked_ip_address"];
export const MAX_CANDIDATES_SCANNED = 20_000;
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

export type ScanResult = {
  // The candidate window held more buyers than MAX_CANDIDATES_SCANNED.
  truncated: boolean;
  // A buyer with settled history and no standing dispute: the scan goes on to read their latest failures.
  survivor: boolean;
};

// Walks the candidate slices in order and stops at the first slice that holds a surviving buyer.
export async function scanUntilSurvivor(now: Date): Promise<ScanResult> {
  const candidateRows = await selectRows<{ email: string }>(
    Prisma.sql`SELECT \`purchases\`.\`email\` FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'failed' AND ${columnIn("purchases", "error_code", BLOCK_ERROR_CODES)} AND \`purchases\`.\`created_at\` >= ${wholeSeconds(ago(FAILURE_LOOKBACK, now))} AND \`purchases\`.\`email\` IS NOT NULL GROUP BY \`purchases\`.\`email\` ORDER BY MAX(purchases.created_at) DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
  );
  const truncated = candidateRows.length > MAX_CANDIDATES_SCANNED;
  const candidates = candidateRows.slice(0, MAX_CANDIDATES_SCANNED).map((row) => row.email);

  for (let start = 0; start < candidates.length; start += HISTORY_COUNT_BATCH) {
    const settled = await settledPurchaseCounts(candidates.slice(start, start + HISTORY_COUNT_BATCH), now);
    if (settled.length === 0) continue;
    const disputed = await disputedEmails(settled);
    if (settled.some((email) => !disputed.has(email))) return { truncated, survivor: true };
  }
  return { truncated, survivor: false };
}
