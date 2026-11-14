// OauthApplication writes (app/models/oauth_application.rb) and the Doorkeeper token generation they rely on (doorkeeper 5.7.1:
// Helpers::UniqueToken is SecureRandom.urlsafe_base64(32), `default_generator_method` being :urlsafe_base64). Timestamps of these
// tables are DATETIME(0): ActiveRecord truncates to whole seconds, so every value written here does too.
import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";

import { transaction } from "./runtime/transaction.ts";
import { column, execute, selectRows, table } from "./sql.ts";

const LOCK_WAIT_SECONDS = 5;
// 60.years.to_i
const SIXTY_YEARS_IN_SECONDS = 1_893_417_120;
// Doorkeeper.configuration.public_scopes.join(" ")
export const DEFAULT_APPLICATION_SCOPES =
  "edit_products edit_emails view_sales mark_sales_as_shipped edit_sales revenue_share ifttt view_profile edit_profile view_payouts view_tax_data account";
export const AGENT_APP_NAME = "Gumroad Store Agent (internal)";

export type OauthApplicationRow = {
  id: number;
  name: string;
  uid: string;
  secret: string;
  redirect_uri: string;
  owner_id: number | null;
  scopes: string;
  deleted_at: Date | null;
};

export const generateUniqueToken = (): string => randomBytes(32).toString("base64url");
const wholeSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

// `current_seller.oauth_applications.alive.find_by_external_id(id)`
export async function findSellerApplication(
  sellerId: bigint | number,
  externalId: string,
): Promise<OauthApplicationRow | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows<OauthApplicationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "owner_id")} = ${sellerId} AND ${column("oauth_applications", "owner_type")} = 'User' AND ${column("oauth_applications", "deleted_at")} IS NULL AND ${column("oauth_applications", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// `SELECT ? = ? COLLATE utf8mb4_unicode_ci`: the database decides, as the controller does.
export async function reservedAgentApplicationName(name: string): Promise<boolean> {
  if (name === "") return false;
  const [row] = await selectRows<Record<string, unknown>>(
    Prisma.sql`SELECT ${name} = ${AGENT_APP_NAME} COLLATE utf8mb4_unicode_ci AS reserved`,
  );
  return Number(row?.reserved) === 1;
}

// #with_application_lock: bounded lock wait around a transaction that locks the application row. Owns the transaction, so a
// lock wait timeout is not retried here (Rails retries it up to three times).
export async function withApplicationLock<T>(applicationId: number, shared: boolean, fn: () => Promise<T>): Promise<T> {
  const [setting] = await selectRows<Record<string, unknown>>(Prisma.sql`SELECT @@SESSION.innodb_lock_wait_timeout`);
  const previous = setting ? Object.values(setting)[0] : null;
  await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${LOCK_WAIT_SECONDS}`));
  try {
    return await transaction(async () => {
      await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} = ${applicationId} LIMIT 1 ${Prisma.raw(shared ? "LOCK IN SHARE MODE" : "FOR UPDATE")}`,
      );
      return fn();
    });
  } finally {
    if (previous != null && String(previous) !== "")
      await execute(Prisma.raw(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(Number(previous))}`));
  }
}

// #get_or_generate_access_token: returns the token string.
export async function getOrGenerateAccessToken(application: OauthApplicationRow, now: () => Date): Promise<string> {
  return withApplicationLock(application.id, false, async () => {
    const ownerId = application.owner_id!;
    const scopes = application.scopes;
    const grants = "oauth_access_grants";
    const [grant] = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`oauth_access_grants`.*")} FROM ${table(grants)} WHERE ${column(grants, "application_id")} = ${application.id} AND ${column(grants, "resource_owner_id")} = ${ownerId} AND ${column(grants, "scopes")} = ${scopes} AND ${column(grants, "redirect_uri")} = ${application.redirect_uri} ORDER BY ${column(grants, "id")} ASC LIMIT 1`,
    );
    if (!grant) {
      await execute(
        Prisma.sql`INSERT INTO ${table(grants)} (${column(grants, "resource_owner_id")}, ${column(grants, "application_id")}, ${column(grants, "token")}, ${column(grants, "expires_in")}, ${column(grants, "redirect_uri")}, ${column(grants, "created_at")}, ${column(grants, "scopes")}) VALUES (${ownerId}, ${application.id}, ${generateUniqueToken()}, ${SIXTY_YEARS_IN_SECONDS}, ${application.redirect_uri}, ${wholeSeconds(now())}, ${scopes})`,
      );
    }
    const tokens = "oauth_access_tokens";
    const [existing] = await selectRows<{ token: string }>(
      Prisma.sql`SELECT ${Prisma.raw("`oauth_access_tokens`.*")} FROM ${table(tokens)} WHERE ${column(tokens, "application_id")} = ${application.id} AND ${column(tokens, "resource_owner_id")} = ${ownerId} AND ${column(tokens, "revoked_at")} IS NULL AND ${column(tokens, "scopes")} = ${scopes} ORDER BY ${column(tokens, "id")} ASC LIMIT 1`,
    );
    if (existing) return existing.token;
    const token = generateUniqueToken();
    await execute(
      Prisma.sql`INSERT INTO ${table(tokens)} (${column(tokens, "resource_owner_id")}, ${column(tokens, "application_id")}, ${column(tokens, "token")}, ${column(tokens, "created_at")}, ${column(tokens, "scopes")}) VALUES (${ownerId}, ${application.id}, ${token}, ${wholeSeconds(now())}, ${scopes})`,
    );
    return token;
  });
}

// #mark_deleted!
export async function markApplicationDeleted(application: OauthApplicationRow, now: () => Date): Promise<void> {
  const deletedAt = wholeSeconds(now());
  const id = application.id;
  await withApplicationLock(id, false, async () => {
    for (const t of ["oauth_access_grants", "oauth_access_tokens"]) {
      await execute(
        Prisma.sql`UPDATE ${table(t)} SET ${column(t, "revoked_at")} = ${deletedAt} WHERE ${column(t, "application_id")} = ${id} AND ${column(t, "revoked_at")} IS NULL`,
      );
    }
    const d = "oauth_device_authorizations";
    await execute(
      Prisma.sql`UPDATE ${table(d)} SET ${column(d, "status")} = 'denied', ${column(d, "denied_at")} = ${now()}, ${column(d, "updated_at")} = ${now()} WHERE ${column(d, "oauth_application_id")} = ${id} AND ${column(d, "status")} IN ('pending', 'approved')`,
    );
    const r = "resource_subscriptions";
    await execute(
      Prisma.sql`UPDATE ${table(r)} SET ${column(r, "deleted_at")} = ${deletedAt} WHERE ${column(r, "oauth_application_id")} = ${id} AND ${column(r, "deleted_at")} IS NULL`,
    );
    const a = "oauth_applications";
    await execute(
      Prisma.sql`UPDATE ${table(a)} SET ${column(a, "deleted_at")} = ${deletedAt}, ${column(a, "updated_at")} = ${deletedAt} WHERE ${column(a, "id")} = ${id}`,
    );
  });
}

// #revoke_access_for(user)
export async function revokeAccessFor(applicationId: number, userId: number | bigint, now: () => Date): Promise<void> {
  await withApplicationLock(applicationId, true, async () => {
    const d = "oauth_device_authorizations";
    await execute(
      Prisma.sql`UPDATE ${table(d)} SET ${column(d, "status")} = 'denied', ${column(d, "denied_at")} = ${now()}, ${column(d, "updated_at")} = ${now()} WHERE ${column(d, "oauth_application_id")} = ${applicationId} AND ${column(d, "resource_owner_id")} = ${userId} AND ${column(d, "status")} = 'approved'`,
    );
    const t = "oauth_access_tokens";
    await execute(
      Prisma.sql`UPDATE ${table(t)} SET ${column(t, "revoked_at")} = ${wholeSeconds(now())} WHERE ${column(t, "resource_owner_id")} = ${userId} AND ${column(t, "application_id")} = ${applicationId} AND ${column(t, "revoked_at")} IS NULL`,
    );
    const r = "resource_subscriptions";
    await execute(
      Prisma.sql`UPDATE ${table(r)} SET ${column(r, "deleted_at")} = ${wholeSeconds(now())} WHERE ${column(r, "user_id")} = ${userId} AND ${column(r, "oauth_application_id")} = ${applicationId} AND ${column(r, "deleted_at")} IS NULL`,
    );
  });
}

// OauthApplication.authorized_for(user).find_by_external_id(id)
export async function findAuthorizedApplication(
  userId: number | bigint,
  externalId: string,
): Promise<{ id: number } | null> {
  const id = decrypt(externalId);
  if (id === null) return null;
  const [row] = await selectRows<{ id: number }>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table("oauth_applications")} WHERE ${column("oauth_applications", "id")} IN (SELECT DISTINCT ${column("oauth_access_tokens", "application_id")} FROM ${table("oauth_access_tokens")} WHERE ${column("oauth_access_tokens", "resource_owner_id")} = ${userId} AND ${column("oauth_access_tokens", "revoked_at")} IS NULL) AND ${column("oauth_applications", "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

export async function insertApplication(
  attrs: { name: string; redirectUri: string; ownerId: number | bigint },
  now: () => Date,
): Promise<number> {
  const a = "oauth_applications";
  const at = wholeSeconds(now());
  return transaction(async () => {
    await execute(
      Prisma.sql`INSERT INTO ${table(a)} (${column(a, "name")}, ${column(a, "uid")}, ${column(a, "secret")}, ${column(a, "redirect_uri")}, ${column(a, "created_at")}, ${column(a, "updated_at")}, ${column(a, "owner_id")}, ${column(a, "owner_type")}, ${column(a, "scopes")}, ${column(a, "confidential")}) VALUES (${attrs.name}, ${generateUniqueToken()}, ${generateUniqueToken()}, ${attrs.redirectUri}, ${at}, ${at}, ${attrs.ownerId}, 'User', ${DEFAULT_APPLICATION_SCOPES}, 0)`,
    );
    const [row] = await selectRows<{ id: number }>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
    return Number(row!.id);
  });
}

// Mcp::OauthClientRegistration#create!: no owner, the secret stored as drawn (Doorkeeper hashes none).
export async function insertDynamicClient(
  attrs: { name: string; redirectUri: string; scopes: string; confidential: boolean },
  now: () => Date,
): Promise<{ uid: string; secret: string; createdAt: Date }> {
  const a = "oauth_applications";
  const createdAt = wholeSeconds(now());
  const uid = generateUniqueToken();
  const secret = generateUniqueToken();
  await execute(
    Prisma.sql`INSERT INTO ${table(a)} (${column(a, "name")}, ${column(a, "uid")}, ${column(a, "secret")}, ${column(a, "redirect_uri")}, ${column(a, "created_at")}, ${column(a, "updated_at")}, ${column(a, "owner_id")}, ${column(a, "owner_type")}, ${column(a, "scopes")}, ${column(a, "confidential")}, ${column(a, "mcp_dynamic_client")}) VALUES (${attrs.name}, ${uid}, ${secret}, ${attrs.redirectUri}, ${createdAt}, ${createdAt}, NULL, 'User', ${attrs.scopes}, ${attrs.confidential ? 1 : 0}, 1)`,
  );
  return { uid, secret, createdAt };
}

export async function updateApplication(
  id: number,
  changes: { name?: string; redirect_uri?: string },
  now: () => Date,
): Promise<void> {
  const entries = Object.entries(changes);
  if (entries.length === 0) return;
  const a = "oauth_applications";
  const sets = entries.map(([name, value]) => Prisma.sql`${column(a, name)} = ${value}`);
  await execute(
    Prisma.sql`UPDATE ${table(a)} SET ${Prisma.join([...sets, Prisma.sql`${column(a, "updated_at")} = ${wholeSeconds(now())}`])} WHERE ${column(a, "id")} = ${id}`,
  );
}
