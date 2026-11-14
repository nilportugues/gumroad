// Port of app/sidekiq/retry_stripe_jp_address_resync_for_seller_job.rb up to the Stripe call: every exit before
// `StripeMerchantAccountManager.handle_new_user_compliance_info` runs in Node (no user, a suspended one, a seller with a connected
// Stripe account or paid out through PayPal, no Stripe account, no compliance revision, no kanji or kana address, no request that is
// due). A seller with a due request is handed back right before the manager call: Stripe is called there and the requests are written
// after it, so the job stays whole in Ruby. Rails sends statements in the order of the Ruby calls below and answers a repeated
// identical SELECT from its query cache; this reads each of them once.
// A seller on the `merchant_migration` Flipper feature, whose connected-account check reads the compliance country, and one with a PayPal
// merchant account, whose payout email may come from PayPal's API, hand back too.
// Golden: __fixtures__/retry-stripe-jp-address-resync-for-seller-job.golden.json
// (scripts/golden/retry-stripe-jp-address-resync-for-seller-job.rb), recorded with the manager replaced by a recorder.
import { Prisma, type BankAccount, type User, type UserComplianceInfoRequest } from "@prisma/client";

import { isFeatureEnabled, userActor } from "../../server/infra/flipper.ts";
import { HandBackToRuby, beforeSideEffects } from "../../server/jobs/hand-back.ts";
import { jsonGet, toHash } from "../../server/models/concerns/json-data.ts";
import { rubyJsonParse } from "../../server/models/concerns/serialized-columns.ts";
import { aliveStripeAccountsOf, isStripeConnectAccount } from "../../server/models/merchant-account.ts";
import { findOneBy, recordIdFrom } from "../../server/models/row-reads.ts";
import { isBlank } from "../../server/models/runtime/validators.ts";
import { castRow, column, quoteName, selectRows, table } from "../../server/models/sql.ts";
import { isFlagSet, isSuspended, NotPortedError, Users } from "../../server/models/user.ts";
import { nativePayoutsSupported } from "../../server/page-props/signed-in/data.ts";
import type { ComplianceInfoRow } from "../../server/page-props/signed-in/reads.ts";

import { dueForRetry } from "./retry-stripe-jp-address-resyncs-job.ts";
import { modelJob } from "./support/job-deps.ts";

const MERCHANT_ACCOUNTS = "merchant_accounts";
const BANK_ACCOUNTS = "bank_accounts";
const COMPLIANCE_INFO = "user_compliance_info";
const REQUESTS = "user_compliance_info_requests";
const FIELD_PREFIXES = ["individual.address_kanji.", "individual.address_kana."];
const MERCHANT_MIGRATION_FEATURE = "merchant_migration";
const PAYPAL_CHARGE_PROCESSOR_ID = "paypal";

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);

type InfoRow = ComplianceInfoRow & { json_data: string | null };

// `user.alive_user_compliance_info`: user_compliance_infos.alive.last
export async function aliveInfo(userId: bigint): Promise<InfoRow | null> {
  const [row] = await selectRows<InfoRow>(
    Prisma.sql`SELECT ${star(COMPLIANCE_INFO)} FROM ${table(COMPLIANCE_INFO)} WHERE ${column(COMPLIANCE_INFO, "user_id")} = ${userId} AND ${column(COMPLIANCE_INFO, "deleted_at")} IS NULL ORDER BY ${column(COMPLIANCE_INFO, "id")} DESC LIMIT 1`,
  );
  return row === undefined ? null : castRow<InfoRow>("UserComplianceInfo", row);
}

// `info.street_address_kanji.blank?` / `street_address_kana.blank?`: attr_json_data_accessor reads of the json_data column.
function addressIsBlank(info: InfoRow, attribute: string): boolean {
  if (isBlank(info.json_data)) return true;
  const hash = toHash(rubyJsonParse(info.json_data!));
  if (hash === null)
    throw new NotPortedError("json_data of a compliance revision that is not a hash", "user_compliance_info.rb");
  return isBlank(jsonGet(hash, attribute));
}

// `user.active_bank_account` (bank_accounts.alive.first)
export async function hasActiveBankAccount(userId: bigint): Promise<boolean> {
  const [row] = await selectRows<BankAccount>(
    Prisma.sql`SELECT ${star(BANK_ACCOUNTS)} FROM ${table(BANK_ACCOUNTS)} WHERE ${column(BANK_ACCOUNTS, "user_id")} = ${userId} AND ${column(BANK_ACCOUNTS, "deleted_at")} IS NULL ORDER BY ${column(BANK_ACCOUNTS, "id")} ASC LIMIT 1`,
  );
  return row !== undefined;
}

// `user.paypal_connect_account.present?`; a PayPal account may be asked for its details, which Node does not do.
export async function hasPaypalAccount(userId: bigint): Promise<boolean> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${star(MERCHANT_ACCOUNTS)} FROM ${table(MERCHANT_ACCOUNTS)} WHERE ${column(MERCHANT_ACCOUNTS, "user_id")} = ${userId} AND ${column(MERCHANT_ACCOUNTS, "deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_alive_at")} IS NOT NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_deleted_at")} IS NULL AND ${column(MERCHANT_ACCOUNTS, "charge_processor_id")} = ${PAYPAL_CHARGE_PROCESSOR_ID}`,
  );
  return rows.length > 0;
}

// `user.user_compliance_info_requests.requested.where(kanji or kana prefix)`
async function addressRequests(userId: bigint): Promise<UserComplianceInfoRequest[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${star(REQUESTS)} FROM ${table(REQUESTS)} WHERE ${column(REQUESTS, "user_id")} = ${userId} AND ${column(REQUESTS, "state")} = 'requested' AND (field_needed LIKE ${`${FIELD_PREFIXES[0]}%`} OR field_needed LIKE ${`${FIELD_PREFIXES[1]}%`})`,
  );
  return rows.map((row) => castRow<UserComplianceInfoRequest>("UserComplianceInfoRequest", row));
}

export const retryStripeJpAddressResyncForSellerJobWith = modelJob({ min: 1 }, async ([userId], deps) => {
  const id = userId === null ? null : await beforeSideEffects(() => recordIdFrom(userId, "User.find_by"));
  const row = await findOneBy<User>("User", "id", id, true);
  if (row === null) return;
  const user = Users.load(row);
  if (isSuspended(user)) return;
  const sellerId = user.get("id");

  // `has_stripe_account_connected?`: `merchant_migration_enabled? && stripe_connect_account.present?`
  let stripeAccounts: Awaited<ReturnType<typeof aliveStripeAccountsOf>> | null = null;
  if (!isFlagSet(user, "check_merchant_account_is_linked")) {
    if (await isFeatureEnabled(MERCHANT_MIGRATION_FEATURE, userActor(sellerId)))
      throw new HandBackToRuby("the Stripe Connect routing country of a seller on merchant_migration is not ported");
  } else {
    stripeAccounts = await aliveStripeAccountsOf(sellerId);
    if (stripeAccounts.some((account) => isStripeConnectAccount(account))) return;
  }

  // `current_payout_processor == PAYPAL`: `(paypal_payout_email.present? && active_bank_account.blank?) || !native_payouts_supported?`
  if (isBlank(user.get("payment_address"))) {
    if (await hasPaypalAccount(sellerId))
      throw new HandBackToRuby("the payout email of a connected PayPal account is not ported");
  } else if (!(await hasActiveBankAccount(sellerId))) {
    return;
  }
  const info = await aliveInfo(sellerId);
  if (info === null || !nativePayoutsSupported(info)) return;

  // `user.stripe_account.blank?`
  stripeAccounts ??= await aliveStripeAccountsOf(sellerId);
  if (!stripeAccounts.some((account) => !isStripeConnectAccount(account))) return;

  const kanjiBlank = addressIsBlank(info, "street_address_kanji");
  if (kanjiBlank && addressIsBlank(info, "street_address_kana")) return;

  const requests = await beforeSideEffects(async () => {
    const all = await addressRequests(sellerId);
    return all.filter((request) => dueForRetry(request, deps.now()));
  });
  if (requests.length === 0) return;

  throw new HandBackToRuby("StripeMerchantAccountManager.handle_new_user_compliance_info calls Stripe");
});

export const retryStripeJpAddressResyncForSellerJob = retryStripeJpAddressResyncForSellerJobWith();
