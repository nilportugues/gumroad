// StripeMerchantAccountManager.handle_stripe_event_account_deauthorized, as HandleStripeEventWorker reaches it for an
// `account.application.deauthorized` event of a connected account (stripe_merchant_account_manager.rb). Stripe is never called: the
// account row is marked deleted in two saves (`delete_charge_processor_account!`), the seller is read for `merchant_migration_enabled?`,
// and a mail job goes to the critical queue. An account id that matches no alive row finishes without a write.
// Golden: worker/jobs/__fixtures__/stripe-account-deauthorized.golden.json (scripts/golden/stripe-account-deauthorized.rb).
import { Prisma } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { beforeSideEffects, HandBackToRuby } from "../jobs/hand-back.ts";
import { deliverLater } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";

import { currentJobsRuntime } from "./concerns/job-runtime.ts";
import { setJsonDataForAttr } from "./concerns/json-data.ts";
import { truncateToSeconds } from "./concerns/ruby-time.ts";
import {
  isStripeConnectAccountRecord,
  MerchantAccountDeletable,
  MerchantAccounts,
  merchantAccountUser,
  STRIPE_CHARGE_PROCESSOR_ID,
  type MerchantAccountRecord,
} from "./merchant-account.ts";
import { RecordInvalid } from "./runtime/errors.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { merchantMigrationEnabled } from "./stripe-merchant-account-disconnect.ts";
import { NotPortedError } from "./user.ts";

const MAILER = "MerchantRegistrationMailer";
const METHOD = "account_deauthorized_to_user";
const MERCHANT_MIGRATION_FEATURE = "merchant_migration";
const MAIL_QUEUE = "critical";

// MerchantAccount.where(charge_processor_id: "stripe", charge_processor_merchant_id:).alive.last
async function lastAliveStripeAccount(stripeAccountId: string): Promise<MerchantAccountRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "charge_processor_id")} = ${STRIPE_CHARGE_PROCESSOR_ID} AND ${column("merchant_accounts", "charge_processor_merchant_id")} = ${stripeAccountId} AND ${column("merchant_accounts", "deleted_at")} IS NULL ORDER BY ${column("merchant_accounts", "id")} DESC LIMIT 1`,
  );
  return row ? MerchantAccounts.load(castRow("MerchantAccount", row)) : null;
}

export async function handleStripeAccountDeauthorized(stripeAccountId: string, now: () => Date): Promise<void> {
  // Hand-backs happen only before the first write: Rails runs the job again from the start.
  const account = await beforeSideEffects(async () => {
    const found = await lastAliveStripeAccount(stripeAccountId);
    // A NULL column is rewritten to {} by Rails' `clear_non_hash_json_data_for_disconnect!` in the first save, like a non-Hash value.
    const jsonData = found === null ? "{}" : found.get("json_data");
    if (typeof jsonData !== "string" || !/^\s*\{/u.test(jsonData))
      throw new NotPortedError(
        "an account whose json_data is not a Hash or is NULL",
        "merchant_account.rb clear_non_hash_json_data_for_disconnect!",
      );
    // `merchant_migration_enabled?` then reads the compliance info and its country rules: Node serves the sellers it is off for.
    if (
      found?.get("user_id") != null &&
      (await isFeatureEnabled(MERCHANT_MIGRATION_FEATURE, userActor(found.get("user_id"))))
    )
      throw new NotPortedError(
        "a seller on the merchant_migration feature",
        "user/feature_status.rb merchant_migration_enabled?",
      );
    return found;
  });
  if (account === null) return;

  try {
    await MerchantAccountDeletable.markDeletedBang(account, { now });
  } catch (error) {
    // Nothing was written: the save validates before its INSERT or UPDATE.
    if (error instanceof RecordInvalid) throw new HandBackToRuby("an account that fails validation");
    throw error;
  }
  if (!isStripeConnectAccountRecord(account)) setJsonDataForAttr(account, "meta", {});
  account.set("charge_processor_deleted_at", truncateToSeconds(now()));
  account.set("charge_processor_alive_at", null);
  account.set("charge_processor_verified_at", null);
  await MerchantAccounts.saveBang(account, { now });

  const seller = await merchantAccountUser(account);
  if (seller === null) throw new TypeError("undefined method 'merchant_migration_enabled?' for nil");
  if (!(await merchantMigrationEnabled(seller))) return;
  await deliverLater(
    currentJobsRuntime(),
    { mailer: MAILER, method: METHOD, args: [Number(seller.get("id")), STRIPE_CHARGE_PROCESSOR_ID], queue: MAIL_QUEUE },
    mailRoute(MAILER, METHOD),
  );
}
