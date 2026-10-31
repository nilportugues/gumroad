// Ports of the jobs that read or move a seller's risk state:
//   app/sidekiq/check_payment_address_worker.rb
//   app/sidekiq/block_suspended_account_ip_worker.rb
import { Prisma } from "@prisma/client";

import { activeScope, addPlatformBlock, IP_ADDRESS_BLOCKING_DURATION_IN_MONTHS, PLATFORM_BLOCK_TYPES } from "../../server/models/platform-block.ts";
import { columnIn, column, selectRows, table } from "../../server/models/sql.ts";
import { canFire, fireRiskEventBang } from "../../server/models/user-risk.ts";
import { findUser, findUserBang, RISK_STATES, type UserRecord } from "../../server/models/user.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { modelJob } from "./support/job-deps.ts";

const SUSPENDED_STATES = RISK_STATES.SUSPENDED;

async function paymentAddressMatchesSuspendedAccount(user: UserRecord, now: Date): Promise<boolean> {
  const paymentAddress = user.get("payment_address");
  if (isBlank(paymentAddress)) return false;
  const [blockedEmail] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table("platform_blocks")} WHERE ${activeScope(now)} AND ${column("platform_blocks", "object_value")} = ${paymentAddress} LIMIT 1`,
  );
  const [banned] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ${column("users", "payment_address")} = ${paymentAddress} AND ${columnIn("users", "user_risk_state", SUSPENDED_STATES)} LIMIT 1`,
  );
  return banned !== undefined || blockedEmail !== undefined;
}

async function stripeFingerprintMatchesSuspendedAccount(user: UserRecord, now: Date): Promise<boolean> {
  const fingerprints = (
    await selectRows<{ stripe_fingerprint: string }>(
      Prisma.sql`SELECT DISTINCT ${column("bank_accounts", "stripe_fingerprint")} FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "user_id")} = ${user.get("id")} AND ${column("bank_accounts", "deleted_at")} IS NULL AND NOT ((${column("bank_accounts", "stripe_fingerprint")} = '' OR ${column("bank_accounts", "stripe_fingerprint")} IS NULL))`,
    )
  ).map((r) => r.stripe_fingerprint);
  if (fingerprints.length === 0) return false;
  const [suspended] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("bank_accounts")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("bank_accounts", "user_id")} WHERE ${columnIn("bank_accounts", "stripe_fingerprint", fingerprints)} AND ${column("bank_accounts", "user_id")} != ${user.get("id")} AND ${columnIn("users", "user_risk_state", SUSPENDED_STATES)} LIMIT 1`,
  );
  if (suspended) return true;
  const blocks = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`platform_blocks`.*")} FROM ${table("platform_blocks")} WHERE ${activeScope(now)} AND ${columnIn("platform_blocks", "object_value", fingerprints)}`,
  );
  return blocks.length > 0;
}

export const checkPaymentAddressWorkerWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const user = await findUser(userId);
  if (!user || !canFire(user, "flag_for_fraud")) return;
  const shouldFlag = (await paymentAddressMatchesSuspendedAccount(user, deps.now())) || (await stripeFingerprintMatchesSuspendedAccount(user, deps.now()));
  if (shouldFlag) await fireRiskEventBang(user, "flag_for_fraud", { author_name: "CheckPaymentAddress" }, { now: deps.now });
});

export const blockSuspendedAccountIpWorkerWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const user = await findUserBang(userId);
  const ip = user.get("last_sign_in_ip");
  if (isBlank(ip)) return;
  const [compliant] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table("users")} WHERE ((current_sign_in_ip = ${ip} OR last_sign_in_ip = ${ip} OR account_created_ip = ${ip}) and user_risk_state = 'compliant') LIMIT 1`,
  );
  if (compliant) return;
  await addPlatformBlock({ objectType: PLATFORM_BLOCK_TYPES.ip_address, objectValue: ip!, expiresIn: { months: IP_ADDRESS_BLOCKING_DURATION_IN_MONTHS } }, deps.now);
});

// Not registered (PORTED_JOBS / JOB_HANDLERS) yet: flagging a compliant seller who has products reaches
// update_product_search_index!, which Node still refuses, and this job has retry: 0, so a refusal
// would drop the check instead of leaving it to Ruby.
export const checkPaymentAddressWorker = checkPaymentAddressWorkerWith();
export const blockSuspendedAccountIpWorker = blockSuspendedAccountIpWorkerWith();
