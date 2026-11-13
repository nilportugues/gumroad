// Port of app/sidekiq/alert_on_blocked_established_subscribers_job.rb up to a stranded subscription: the candidate subscriptions with
// a blocked renewal and their successful-charge counts. A scan where none clears the floor has nothing to report and the job returns
// without notifying. A subscription that does needs the latest failures and DecliningPlatformBlocks, and a scan that hit its candidate
// budget reports even when nobody qualifies, so both are handed back; the job has written nothing by then.
// Golden: __fixtures__/alert-on-blocked-established-subscribers-job.golden.json (scripts/golden/alert-on-blocked-established-subscribers-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { columnIn, selectRows } from "../../server/models/sql.ts";

import { modelJob } from "./support/job-deps.ts";

const FAILURE_LOOKBACK = { days: 30 };
const BLOCK_ERROR_CODES = ["blocked_browser_guid", "blocked_email_domain"];
const MIN_SUCCESSFUL_CHARGES = 6;
const MAX_CANDIDATES_SCANNED = 10_000;
const CHARGE_COUNT_BATCH = 500;
const MS_PER_SECOND = 1000;

// purchases.created_at is datetime(0): ActiveRecord binds the bound without its fraction.
const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / MS_PER_SECOND) * MS_PER_SECOND);

// `Purchase.failed.recurring_charge.not_is_gift_receiver_purchase.where(error_code:, created_at: 30.days.ago..)`, the original-purchase
// and gift-receiver bits being flags 4 and 32.
async function candidateSubscriptionIds(now: Date): Promise<number[]> {
  const rows = await selectRows<{ subscription_id: number | bigint }>(
    Prisma.sql`SELECT \`purchases\`.\`subscription_id\` FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'failed' AND (purchases.subscription_id IS NOT NULL AND purchases.flags & '4' = 0) AND ((\`purchases\`.\`flags\` & 32 = 0)) AND ${columnIn("purchases", "error_code", BLOCK_ERROR_CODES)} AND \`purchases\`.\`created_at\` >= ${wholeSeconds(ago(FAILURE_LOOKBACK, now))} GROUP BY \`purchases\`.\`subscription_id\` ORDER BY MAX(purchases.created_at) DESC LIMIT ${Prisma.raw(String(MAX_CANDIDATES_SCANNED + 1))}`,
  );
  return rows.map((row) => Number(row.subscription_id));
}

// `Purchase.successful.where(subscription_id:).group(:subscription_id).count`, kept at MIN_SUCCESSFUL_CHARGES or more.
async function establishedSubscriptionCount(subscriptionIds: number[]): Promise<number> {
  const rows = await selectRows<{ count_all: number | bigint }>(
    Prisma.sql`SELECT COUNT(*) AS \`count_all\`, \`purchases\`.\`subscription_id\` AS \`purchases_subscription_id\` FROM \`purchases\` WHERE \`purchases\`.\`purchase_state\` = 'successful' AND ${columnIn("purchases", "subscription_id", subscriptionIds)} GROUP BY \`purchases\`.\`subscription_id\``,
  );
  return rows.filter((row) => Number(row.count_all) >= MIN_SUCCESSFUL_CHARGES).length;
}

export const alertOnBlockedEstablishedSubscribersJobWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const candidateRows = await candidateSubscriptionIds(deps.now());
  const truncated = candidateRows.length > MAX_CANDIDATES_SCANNED;
  const candidates = candidateRows.slice(0, MAX_CANDIDATES_SCANNED);

  for (let start = 0; start < candidates.length; start += CHARGE_COUNT_BATCH) {
    if ((await establishedSubscriptionCount(candidates.slice(start, start + CHARGE_COUNT_BATCH))) > 0)
      throw new HandBackToRuby("an established subscription needs the latest failures and DecliningPlatformBlocks");
  }
  if (truncated) throw new HandBackToRuby("a truncated scan reports even when no subscription qualifies");
});

export const alertOnBlockedEstablishedSubscribersJob = alertOnBlockedEstablishedSubscribersJobWith();
