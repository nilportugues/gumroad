// Port of app/sidekiq/stripe_create_merchant_accounts_worker.rb: the sellers who are compliant or not reviewed, have a compliance
// revision, a bank account, a TOS agreement and a balance from the last 3 months, and no merchant account at all (a deleted one
// counts), get CreateStripeMerchantAccountWorker once when their compliance country has native payouts and is not blocked for new
// accounts. Only reads and pushes: nothing is created here.
// Golden: __fixtures__/stripe-create-merchant-accounts-worker.golden.json (scripts/golden/stripe-create-merchant-accounts-worker.rb).
import { Prisma } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { castRow, column, columnIn, quoteName, selectRows, table } from "../../server/models/sql.ts";
import {
  blockedPayoutCountry,
  legalEntityCountryCode,
  nativePayoutsSupported,
} from "../../server/page-props/signed-in/data.ts";
import type { ComplianceInfoRow } from "../../server/page-props/signed-in/reads.ts";

import { modelJob } from "./support/job-deps.ts";

const USERS = "users";
const COMPLIANCE_INFO = "user_compliance_info";
const CREATE_JOB = "CreateStripeMerchantAccountWorker";
const PERIOD_INDICATING_USER_IS_ACTIVE_MONTHS = 3;

// `3.months.ago`: the day is clamped to the end of the target month.
function monthsAgo(now: Date, months: number): Date {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  target.setUTCHours(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), 0);
  return target;
}

// `to_formatted_s(:db)`
const dbTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last (Rails answers the second read from its query cache)
async function aliveInfo(userId: bigint): Promise<ComplianceInfoRow | null> {
  const [row] = await selectRows<ComplianceInfoRow>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(COMPLIANCE_INFO)}.*`)} FROM ${table(COMPLIANCE_INFO)} WHERE ${column(COMPLIANCE_INFO, "user_id")} = ${userId} AND ${column(COMPLIANCE_INFO, "deleted_at")} IS NULL ORDER BY ${column(COMPLIANCE_INFO, "id")} DESC LIMIT 1`,
  );
  return row === undefined ? null : castRow<ComplianceInfoRow>("UserComplianceInfo", row);
}

export const stripeCreateMerchantAccountsWorkerWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const since = dbTime(monthsAgo(deps.now(), PERIOD_INDICATING_USER_IS_ACTIVE_MONTHS));
  const candidates = await selectRows<{ id: bigint }>(
    Prisma.raw(`WITH cte AS (
  SELECT * FROM users
  WHERE
    users.user_risk_state IN ("compliant", "not_reviewed")
)
SELECT distinct(cte.id) FROM cte
INNER JOIN user_compliance_info
  ON user_compliance_info.user_id = cte.id
  AND user_compliance_info.deleted_at IS NULL
INNER JOIN bank_accounts
  ON bank_accounts.user_id = cte.id
  AND bank_accounts.deleted_at IS NULL
INNER JOIN tos_agreements
  ON tos_agreements.user_id = cte.id
INNER JOIN balances
  ON balances.user_id = cte.id
  AND balances.created_at > "${since}"
LEFT JOIN merchant_accounts
  ON merchant_accounts.user_id = cte.id
WHERE
  merchant_accounts.id IS NULL
`),
  );
  const ids = candidates.map((row) => Object.values(row)[0] as bigint);
  // `where(id: [])` is answered without a query.
  if (ids.length === 0) return;
  const users = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName(USERS)}.*`)} FROM ${table(USERS)} WHERE ${columnIn(USERS, "id", ids)}`,
  );
  for (const user of users) {
    const info = await aliveInfo(user.id);
    if (!nativePayoutsSupported(info)) continue;
    if (blockedPayoutCountry(info === null ? null : legalEntityCountryCode(info))) continue;
    await performAsync(CREATE_JOB, [user.id]);
  }
});

export const stripeCreateMerchantAccountsWorker = stripeCreateMerchantAccountsWorkerWith();
