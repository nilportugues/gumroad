// User#revoke_all_oauth_access! and User#revoke_unproven_access! (app/models/user.rb), run when a Google or Apple sign-in adopts
// an account whose address was never confirmed. Two transactions, as in Rails: sign-in access first, so a failure removing payout or
// team rows cannot keep it alive.
import { Prisma, type MerchantAccount, type TeamInvitation, type TeamMembership } from "@prisma/client";

import { BankAccountDeletable, aliveBankAccountsOf } from "./bank-account.ts";
import { jsonData, setJsonDataForAttr as setMerchantJsonDataForAttr } from "./concerns/json-data.ts";
import { RubyHash } from "./concerns/psych.ts";
import {
  isStripeConnectAccountRecord,
  MerchantAccountDeletable,
  MerchantAccounts,
  type MerchantAccountRecord,
} from "./merchant-account.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, execute, selectRows, table } from "./sql.ts";
import { TeamInvitationDeletable, TeamInvitations } from "./team-invitation.ts";
import { TeamMembershipDeletable, TeamMemberships } from "./team-membership.ts";
import { setFlag, setJsonDataForAttr, Users, type UserRecord } from "./user.ts";

const TWITTER_PROPERTIES = [
  "twitter_user_id",
  "twitter_handle",
  "twitter_oauth_token",
  "twitter_oauth_secret",
] as const;
const wholeSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);
// `Time.current.iso8601`
const iso8601 = (date: Date) => date.toISOString().replace(/\.\d+Z$/u, "Z");

// revoke_all_oauth_access!. The grant, token and subscription columns are datetime(0), so update_all casts to whole seconds.
export async function revokeAllOauthAccess(user: UserRecord, now: () => Date): Promise<void> {
  const revokedAt = now();
  const userId = user.get("id");
  const device = "oauth_device_authorizations";
  await execute(
    Prisma.sql`UPDATE ${table(device)} SET ${column(device, "status")} = 'denied', ${column(device, "denied_at")} = ${revokedAt}, ${column(device, "updated_at")} = ${revokedAt} WHERE ${column(device, "resource_owner_id")} = ${userId} AND ${column(device, "status")} = 'approved'`,
  );
  const seconds = wholeSeconds(revokedAt);
  for (const name of ["oauth_access_grants", "oauth_access_tokens"]) {
    await execute(
      Prisma.sql`UPDATE ${table(name)} SET ${column(name, "revoked_at")} = ${seconds} WHERE ${column(name, "resource_owner_id")} = ${userId} AND ${column(name, "revoked_at")} IS NULL`,
    );
  }
  const subscriptions = "resource_subscriptions";
  await execute(
    Prisma.sql`UPDATE ${table(subscriptions)} SET ${column(subscriptions, "deleted_at")} = ${seconds} WHERE ${column(subscriptions, "user_id")} = ${userId} AND ${column(subscriptions, "deleted_at")} IS NULL`,
  );
}

// `credentials.destroy_all`: one DELETE per row; none of these models has a destroy callback.
async function destroyAll(tableName: string, userId: unknown): Promise<void> {
  const rows = await selectRows<{ id: unknown }>(
    Prisma.sql`SELECT ${column(tableName, "id")} AS id FROM ${table(tableName)} WHERE ${column(tableName, "user_id")} = ${userId} ORDER BY ${column(tableName, "id")} ASC`,
  );
  for (const { id } of rows)
    await execute(Prisma.sql`DELETE FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id}`);
}

// clear_non_hash_json_data_for_disconnect!: a column that is not a Hash is replaced with one.
function clearNonHashJsonData(account: MerchantAccountRecord): void {
  const raw = account.get("json_data");
  if (raw == null || (typeof raw === "string" && /^\s*\{/u.test(raw))) return;
  account.set("json_data", "{}");
}

// MerchantAccount#delete_charge_processor_account!(validate: false)
async function deleteChargeProcessorAccount(account: MerchantAccountRecord, now: () => Date): Promise<void> {
  clearNonHashJsonData(account);
  await MerchantAccountDeletable.markDeletedBang(account, { validate: false, now });
  if (!isStripeConnectAccountRecord(account)) setMerchantJsonDataForAttr(account, "meta", new RubyHash([]));
  account.set("charge_processor_deleted_at", wholeSeconds(now()));
  account.set("charge_processor_alive_at", null);
  account.set("charge_processor_verified_at", null);
  await MerchantAccounts.saveBang(account, { validate: false, now });
}

// MerchantAccount#mark_retired_by_adoption!
async function markRetiredByAdoption(account: MerchantAccountRecord, now: () => Date): Promise<void> {
  clearNonHashJsonData(account);
  jsonData(account);
  setMerchantJsonDataForAttr(account, "retired_by_adoption_at", iso8601(now()));
  await MerchantAccounts.saveBang(account, { validate: false, now });
}

// `user.merchant_accounts` (all, or `.alive`) in primary key order, as `each` and `find_each` read it.
async function merchantAccountsOf(userId: unknown, aliveOnly: boolean): Promise<MerchantAccountRecord[]> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`merchant_accounts`.*")} FROM ${table("merchant_accounts")} WHERE ${column("merchant_accounts", "user_id")} = ${userId}${aliveOnly ? Prisma.sql` AND ${column("merchant_accounts", "deleted_at")} IS NULL` : Prisma.empty} ORDER BY ${column("merchant_accounts", "id")} ASC`,
  );
  return rows.map((row) => MerchantAccounts.load(castRow<MerchantAccount>("MerchantAccount", row)));
}

// `seller_memberships.role_not_owner` / `user_memberships.role_not_owner`, then `.not_deleted`.
async function removeMemberships(owner: "seller_id" | "user_id", userId: unknown, now: () => Date): Promise<void> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.*")} FROM ${table("team_memberships")} WHERE ${column("team_memberships", owner)} = ${userId} AND ${column("team_memberships", "role")} != 'owner' AND ${column("team_memberships", "deleted_at")} IS NULL ORDER BY ${column("team_memberships", "id")} ASC`,
  );
  for (const row of rows)
    await TeamMembershipDeletable.markDeletedBang(
      TeamMemberships.load(castRow<TeamMembership>("TeamMembership", row)),
      {
        validate: false,
        now,
      },
    );
}

// `team_invitations.not_accepted.not_deleted`
async function removeInvitations(userId: unknown, now: () => Date): Promise<void> {
  const rows = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`team_invitations`.*")} FROM ${table("team_invitations")} WHERE ${column("team_invitations", "seller_id")} = ${userId} AND ${column("team_invitations", "accepted_at")} IS NULL AND ${column("team_invitations", "deleted_at")} IS NULL ORDER BY ${column("team_invitations", "id")} ASC`,
  );
  for (const row of rows)
    await TeamInvitationDeletable.markDeletedBang(
      TeamInvitations.load(castRow<TeamInvitation>("TeamInvitation", row)),
      {
        validate: false,
        now,
      },
    );
}

export async function revokeUnprovenAccess(user: UserRecord, now: () => Date): Promise<void> {
  const userId = user.get("id");
  await transaction(async () => {
    user.set("unconfirmed_email", null);
    user.set("confirmation_token", null);
    for (const property of TWITTER_PROPERTIES) user.set(property, null);
    await Users.saveBang(user, { now });
    await revokeAllOauthAccess(user, now);
    await destroyAll("webauthn_credentials", userId);
    await destroyAll("totp_credentials", userId);
    await destroyAll("devices", userId);
  });

  await transaction(async () => {
    user.set("notification_endpoint", null);
    user.set("payment_address", "");
    setJsonDataForAttr(user, "invalidated_paypal_payout_address", null);
    setFlag(user, "check_merchant_account_is_linked", false);
    await Users.saveBang(user, { now });
    for (const account of await merchantAccountsOf(userId, true)) await deleteChargeProcessorAccount(account, now);
    for (const account of await merchantAccountsOf(userId, false)) await markRetiredByAdoption(account, now);
    for (const bank of await aliveBankAccountsOf(userId))
      await BankAccountDeletable.markDeletedBang(bank, { validate: false, now });
    await removeMemberships("seller_id", userId, now);
    await removeMemberships("user_id", userId, now);
    await removeInvitations(userId, now);
  });
}
