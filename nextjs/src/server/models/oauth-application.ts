// OauthApplication.first_party_mobile and #revoke_access_tokens_for (app/models/oauth_application.rb),
// with Doorkeeper::AccessToken.revoke_all_for (doorkeeper 5.8).
import { Prisma } from "@prisma/client";

import { getConfig } from "../infra/config.ts";

import { columnIn, column, execute, selectRows, table } from "./sql.ts";

// Client id compiled into the pre-Expo Android and iOS apps.
const LEGACY_MOBILE_API_OAUTH_APPLICATION_UID = "46410c2fb9aa741c1f03cdea099929c795d20de0282b352eac881dfa46b2b89c";
const LOCK_WAIT_SECONDS = 5;

type OauthApplicationRow = { id: number | bigint };

// OauthApplication.first_party_mobile
export function firstPartyMobileApplications(): Promise<OauthApplicationRow[]> {
  const uids = [getConfig("MOBILE_API_OAUTH_APPLICATION_UID"), LEGACY_MOBILE_API_OAUTH_APPLICATION_UID].filter((uid) => uid != null);
  return selectRows<OauthApplicationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table("oauth_applications")} WHERE ${columnIn("oauth_applications", "uid", uids)}`,
  );
}

// with_bounded_lock_wait: the session's wait is restored even when the block fails.
async function withBoundedLockWait<T>(fn: () => Promise<T>): Promise<T> {
  const [row] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT @@SESSION.innodb_lock_wait_timeout`);
  const previous = row ? Object.values(row)[0] : null;
  await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${LOCK_WAIT_SECONDS}`));
  try {
    return await fn();
  } finally {
    if (previous != null && String(previous) !== "") await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(Number(previous))}`));
  }
}

// #revoke_access_tokens_for(user), always called inside the suspension's transaction: there
// with_application_lock does not own the transaction, so a lock wait timeout is not retried.
export async function revokeAccessTokensFor(application: OauthApplicationRow, userId: unknown, now: () => Date): Promise<void> {
  const revokedAt = now();
  await withBoundedLockWait(async () => {
    await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${application.id} LIMIT 1 LOCK IN SHARE MODE`,
    );
    const t = "oauth_device_authorizations";
    await execute(
      Prisma.sql`UPDATE ${table(t)} SET ${column(t, "status")} = 'denied', ${column(t, "denied_at")} = ${revokedAt}, ${column(t, "updated_at")} = ${revokedAt} WHERE ${column(t, "oauth_application_id")} = ${application.id} AND ${column(t, "resource_owner_id")} = ${userId} AND ${column(t, "status")} = 'approved'`,
    );
    // revoked_at is a datetime(0) column, so update_all casts Time.now.utc to whole seconds.
    const seconds = new Date(Math.floor(now().getTime() / 1000) * 1000);
    const a = "oauth_access_tokens";
    await execute(
      Prisma.sql`UPDATE ${table(a)} SET ${column(a, "revoked_at")} = ${seconds} WHERE ${column(a, "resource_owner_id")} = ${userId} AND ${column(a, "application_id")} = ${application.id} AND ${column(a, "revoked_at")} IS NULL`,
    );
  });
}
