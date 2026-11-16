// Port of app/sidekiq/alert_on_negative_destination_balances_job.rb up to the first candidate: `candidate_pairs`, the keyset walk over
// unpaid balances grouped by seller and merchant account that keeps the pairs whose destination total is negative without a negative USD
// ledger beside it. It reads nothing but `balances`. A scan that keeps no pair ends the run with no alert. One that keeps a pair goes on
// to read each seller's merchant account, payability and ledger windows and push the alert, so it hands back whole after the scan,
// before any write.
// Golden: __fixtures__/alert-on-negative-destination-balances-job.golden.json
// (scripts/golden/alert-on-negative-destination-balances-job.rb).
import { Prisma } from "@prisma/client";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { selectRows } from "../../server/models/sql.ts";
import { addDays, dateOnly, isoDate, PAYOUT_DELAY_DAYS } from "../../server/page-props/payouts/payout-schedule.ts";

import { modelJob } from "./support/job-deps.ts";

const MAX_CANDIDATES_SCANNED = 12_000;
const USER_BATCH_SIZE = 25_000;
const FRIDAY = 5;

// User::PayoutSchedule.next_scheduled_payout_end_date: the next Friday (today, on a Friday) less the payout delay.
function payoutCutoffDate(now: Date): string {
  const today = dateOnly(now);
  const nextFriday = addDays(today, (FRIDAY - today.getUTCDay() + 7) % 7);
  return isoDate(addDays(nextFriday, -PAYOUT_DELAY_DAYS));
}

// SUM over an integer column is a DECIMAL; `-0` is not negative.
const negative = (value: unknown): boolean => new Prisma.Decimal(String(value)).lt(0);

export const alertOnNegativeDestinationBalancesJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const cutoff = payoutCutoffDate(deps.now());
  let pairs = 0;
  let lastUserId = "0";
  let lastMerchantAccountId = "0";

  for (;;) {
    const batch = await selectRows<Record<string, unknown>>(
      Prisma.sql`SELECT \`balances\`.\`user_id\`, \`balances\`.\`merchant_account_id\`, SUM(holding_amount_cents), SUM(CASE WHEN date <= ${cutoff} THEN holding_amount_cents ELSE 0 END), SUM(amount_cents), SUM(CASE WHEN date <= ${cutoff} THEN amount_cents ELSE 0 END) FROM \`balances\` WHERE \`balances\`.\`state\` = 'unpaid' AND \`balances\`.\`merchant_account_id\` IS NOT NULL AND ((user_id > ${lastUserId}) OR (user_id = ${lastUserId} AND merchant_account_id > ${lastMerchantAccountId})) GROUP BY \`balances\`.\`user_id\`, \`balances\`.\`merchant_account_id\` ORDER BY \`balances\`.\`user_id\` ASC, \`balances\`.\`merchant_account_id\` ASC LIMIT ${Prisma.raw(String(USER_BATCH_SIZE))}`,
    );
    if (batch.length === 0) break;

    // Refund-netted windows cannot trip the payout guard.
    for (const row of batch) {
      const [, , holding, inCycle, usd, inCycleUsd] = Object.values(row);
      if ((negative(holding) && !negative(usd)) || (negative(inCycle) && !negative(inCycleUsd))) pairs += 1;
    }
    const [userId, merchantAccountId] = Object.values(batch[batch.length - 1]!);
    lastUserId = String(userId);
    lastMerchantAccountId = String(merchantAccountId);
    if (pairs > MAX_CANDIDATES_SCANNED) break;
  }

  if (pairs === 0) return;
  throw new HandBackToRuby(
    "each candidate's merchant account, payability and ledger windows are read and the alert pushed",
  );
});
export const alertOnNegativeDestinationBalancesJob = alertOnNegativeDestinationBalancesJobWith();
