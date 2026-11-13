// Port of app/sidekiq/stripe_create_merchant_accounts_worker.rb: sellers in good standing with a compliance revision, a bank account,
// a signed agreement and a balance from the last three months, and no merchant account of any kind (deleted ones count), get
// CreateStripeMerchantAccountWorker when their payout country is native and not blocked for new accounts. The discovery statement is
// the heredoc's text with the cutoff written the way `to_formatted_s(:db)` does; Rails sends no users statement for an empty list and
// reads each seller's compliance revision once (a repeated SELECT is answered from its query cache).
// Golden: __fixtures__/stripe-create-merchant-accounts-worker.golden.json (scripts/golden/stripe-create-merchant-accounts-worker.rb).
import { Prisma } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { ago } from "../../server/models/concerns/ruby-time.ts";
import { castRow, columnIn, quoteName, selectRows, table } from "../../server/models/sql.ts";
import {
  blockedPayoutCountry,
  legalEntityCountryCode,
  nativePayoutsSupported,
} from "../../server/page-props/signed-in/data.ts";
import type { ComplianceInfoRow } from "../../server/page-props/signed-in/reads.ts";

import { modelJob } from "./support/job-deps.ts";

const PERIOD_INDICATING_USER_IS_ACTIVE = { months: 3 };
const CREATE_JOB = "CreateStripeMerchantAccountWorker";
const COMPLIANCE_INFO = "user_compliance_info";

const dbTime = (time: Date) => time.toISOString().slice(0, 19).replace("T", " ");

const discoverySql = (activeSince: string) => `WITH cte AS (
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
  AND balances.created_at > "${activeSince}"
LEFT JOIN merchant_accounts
  ON merchant_accounts.user_id = cte.id
WHERE
  merchant_accounts.id IS NULL
`;

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
async function aliveInfo(userId: bigint): Promise<ComplianceInfoRow | null> {
  const name = quoteName(COMPLIANCE_INFO);
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`${name}.*`)} FROM ${table(COMPLIANCE_INFO)} WHERE ${Prisma.raw(`${name}.${quoteName("user_id")}`)} = ${userId} AND ${Prisma.raw(`${name}.${quoteName("deleted_at")}`)} IS NULL ORDER BY ${Prisma.raw(`${name}.${quoteName("id")}`)} DESC LIMIT 1`,
  );
  return row === undefined ? null : castRow<ComplianceInfoRow>("UserComplianceInfo", row);
}

export const stripeCreateMerchantAccountsWorkerWith = modelJob({ min: 0, max: 0 }, async (_args, deps) => {
  const activeSince = dbTime(ago(PERIOD_INDICATING_USER_IS_ACTIVE, deps.now()));
  const found = await selectRows<{ id: bigint | number }>(Prisma.raw(discoverySql(activeSince)));
  const userIds = found.map((row) => BigInt(row.id));
  if (userIds.length === 0) return;

  const users = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT ${Prisma.raw(`${quoteName("users")}.*`)} FROM ${table("users")} WHERE ${columnIn("users", "id", userIds)}`,
  );
  for (const user of users) {
    const info = await aliveInfo(user.id);
    if (!nativePayoutsSupported(info)) continue;
    if (blockedPayoutCountry(legalEntityCountryCode(info!))) continue;
    await performAsync(CREATE_JOB, [user.id]);
  }
});

export const stripeCreateMerchantAccountsWorker = stripeCreateMerchantAccountsWorkerWith();
