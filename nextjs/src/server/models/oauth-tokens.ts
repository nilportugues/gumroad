// The Doorkeeper lookups behind Oauth::TokensController (doorkeeper 5.7.1). Gumroad stores tokens and client secrets as plaintext
// (no hash_token_secrets / hash_application_secrets), so a lookup is an equality the database decides, collation included.
import { randomBytes, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { transaction } from "./runtime/transaction.ts";
import { column, execute, selectRows, table } from "./sql.ts";

export type ApplicationRow = {
  id: number;
  uid: string;
  secret: string;
  confidential: unknown;
  mcp_dynamic_client: unknown;
  scopes: string;
  deleted_at: Date | null;
  device_authorization_enabled: unknown;
};
export type AccessTokenRow = {
  id: number;
  application_id: number;
  token: string;
  expires_in: number | null;
  revoked_at: Date | null;
  created_at: Date;
  scopes: string | null;
  refresh_token: string | null;
  resource_owner_id: number | null;
  resource: string | null;
  team_membership_id: number | bigint | null;
};
export type AccessGrantRow = {
  id: number;
  application_id: number;
  expires_in: number;
  revoked_at: Date | null;
  created_at: Date;
  redirect_uri: string;
  token: string;
  scopes: string;
  resource_owner_id: number;
  code_challenge: string | null;
  code_challenge_method: string | null;
  resource: string | null;
};

const APPLICATIONS = "oauth_applications";
const TOKENS = "oauth_access_tokens";
const GRANTS = "oauth_access_grants";
const MILLISECONDS_PER_SECOND = 1000;

export const truthy = (value: unknown): boolean => value === true || Number(value) === 1;

// Doorkeeper::Application.by_uid: `find_by(uid: uid.to_s)`, deleted applications included.
export async function findApplicationByUid(uid: string): Promise<ApplicationRow | null> {
  const [row] = await selectRows<ApplicationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table(APPLICATIONS)} WHERE ${column(APPLICATIONS, "uid")} = ${uid} LIMIT 1`,
  );
  return row ?? null;
}

// OauthApplication.alive.find_by(uid:)
export async function findAliveApplicationByUid(uid: string): Promise<ApplicationRow | null> {
  const [row] = await selectRows<ApplicationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table(APPLICATIONS)} WHERE ${column(APPLICATIONS, "deleted_at")} IS NULL AND ${column(APPLICATIONS, "uid")} = ${uid} LIMIT 1`,
  );
  return row ?? null;
}

export async function findApplicationById(id: number): Promise<ApplicationRow | null> {
  const [row] = await selectRows<ApplicationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_applications`.*")} FROM ${table(APPLICATIONS)} WHERE ${column(APPLICATIONS, "id")} = ${id} LIMIT 1`,
  );
  return row ?? null;
}

// SecretStoring::Plain#secret_matches?: ActiveSupport::SecurityUtils.secure_compare of the two strings.
export function secretMatches(input: string, stored: string): boolean {
  const given = Buffer.from(input);
  const known = Buffer.from(stored);
  return given.length === known.length && timingSafeEqual(given, known);
}

export async function findAccessToken(by: "token" | "refresh_token", value: string): Promise<AccessTokenRow | null> {
  const [row] = await selectRows<AccessTokenRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_access_tokens`.*")} FROM ${table(TOKENS)} WHERE ${column(TOKENS, by)} = ${value} LIMIT 1`,
  );
  return row ?? null;
}

export async function findAccessGrant(token: string): Promise<AccessGrantRow | null> {
  const [row] = await selectRows<AccessGrantRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_access_grants`.*")} FROM ${table(GRANTS)} WHERE ${column(GRANTS, "token")} = ${token} LIMIT 1`,
  );
  return row ?? null;
}

// Models::Expirable#expired? and Models::Revocable#revoked?
export function accessible(
  record: { expires_in: number | null; created_at: Date; revoked_at: Date | null },
  now: Date,
): boolean {
  const expired =
    record.expires_in !== null &&
    now.getTime() > record.created_at.getTime() + record.expires_in * MILLISECONDS_PER_SECOND;
  const revoked = record.revoked_at !== null && record.revoked_at.getTime() <= now.getTime();
  return !expired && !revoked;
}

// AccessToken#revoke: `update_attribute(:revoked_at, Time.now.utc)` on a DATETIME(0) column, so whole seconds.
export async function revokeAccessToken(id: number, now: Date): Promise<void> {
  const seconds = new Date(Math.floor(now.getTime() / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND);
  await execute(
    Prisma.sql`UPDATE ${table(TOKENS)} SET ${column(TOKENS, "revoked_at")} = ${seconds} WHERE ${column(TOKENS, "id")} = ${id}`,
  );
}

const wholeSeconds = (date: Date) =>
  new Date(Math.floor(date.getTime() / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND);

// Helpers::UniqueToken: SecureRandom.urlsafe_base64(32)
export const generateUniqueToken = (): string => randomBytes(32).toString("base64url");

export type NewAccessToken = {
  applicationId: number;
  resourceOwnerId: number | null;
  scopes: string;
  expiresIn: number | null;
  useRefreshToken: boolean;
  resource: string | null;
  createdAt: Date;
};
export type IssuedAccessToken = NewAccessToken & { token: string; refreshToken: string | null };

// AccessToken.create_for: the token is generated before the row is saved, and the refresh token after it (generate_token, then
// generate_refresh_token when `use_refresh_token` is set). `created_at` is a DATETIME(0): whole seconds in the row.
export async function insertAccessToken(attributes: NewAccessToken): Promise<IssuedAccessToken> {
  const token = generateUniqueToken();
  const refreshToken = attributes.useRefreshToken ? generateUniqueToken() : null;
  await execute(
    Prisma.sql`INSERT INTO ${table(TOKENS)} (${column(TOKENS, "resource_owner_id")}, ${column(TOKENS, "application_id")}, ${column(TOKENS, "token")}, ${column(TOKENS, "refresh_token")}, ${column(TOKENS, "expires_in")}, ${column(TOKENS, "created_at")}, ${column(TOKENS, "scopes")}, ${column(TOKENS, "resource")}) VALUES (${attributes.resourceOwnerId}, ${attributes.applicationId}, ${token}, ${refreshToken}, ${attributes.expiresIn}, ${wholeSeconds(attributes.createdAt)}, ${attributes.scopes}, ${attributes.resource})`,
  );
  return { ...attributes, token, refreshToken };
}

// Revocable#revoke: `update_attribute(:revoked_at, Time.now.utc)`.
export async function revokeAccessGrant(id: number, now: Date): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table(GRANTS)} SET ${column(GRANTS, "revoked_at")} = ${wholeSeconds(now)} WHERE ${column(GRANTS, "id")} = ${id}`,
  );
}

// `record.lock!` in a transaction: the row is read again FOR UPDATE, so a request that lost the race sees it revoked.
export async function lockAccessGrant(id: number): Promise<AccessGrantRow | null> {
  const [row] = await selectRows<AccessGrantRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_access_grants`.*")} FROM ${table(GRANTS)} WHERE ${column(GRANTS, "id")} = ${id} LIMIT 1 FOR UPDATE`,
  );
  return row ?? null;
}

export async function lockAccessToken(id: number): Promise<AccessTokenRow | null> {
  const [row] = await selectRows<AccessTokenRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_access_tokens`.*")} FROM ${table(TOKENS)} WHERE ${column(TOKENS, "id")} = ${id} LIMIT 1 FOR UPDATE`,
  );
  return row ?? null;
}

// MobileAccountToken.valid?: a brand token (one with a team membership) stays usable while the website would still let its member switch
// in: an admin membership of the token's owner that is not deleted, a live owner and member, and no session invalidation after the token.
export async function brandTokenValid(token: AccessTokenRow): Promise<boolean> {
  if (token.team_membership_id === null) return true;
  const [membership] = await selectRows<{ user_id: bigint | null }>(
    Prisma.sql`SELECT ${Prisma.raw("`team_memberships`.`user_id`")} FROM ${table("team_memberships")} INNER JOIN ${table("users")} ON ${column("users", "id")} = ${column("team_memberships", "seller_id")} WHERE ${column("team_memberships", "role")} = 'admin' AND ${column("team_memberships", "deleted_at")} IS NULL AND ${column("users", "deleted_at")} IS NULL AND ${column("team_memberships", "id")} = ${token.team_membership_id} AND ${column("team_memberships", "seller_id")} = ${token.resource_owner_id} LIMIT 1`,
  );
  if (membership === undefined || membership.user_id === null) return false;
  const [member] = await selectRows<{ deleted_at: Date | null; last_active_sessions_invalidated_at: Date | null }>(
    Prisma.sql`SELECT ${column("users", "deleted_at")}, ${column("users", "last_active_sessions_invalidated_at")} FROM ${table("users")} WHERE ${column("users", "id")} = ${membership.user_id} LIMIT 1`,
  );
  if (member === undefined || member.deleted_at !== null) return false;
  const invalidatedAt = member.last_active_sessions_invalidated_at;
  return invalidatedAt === null || token.created_at.getTime() > invalidatedAt.getTime();
}

// Doorkeeper's before_successful_strategy_response: a refreshed brand token keeps the team membership of the one it replaces
// (`update_column`, so no `updated_at`).
export async function copyTeamMembership(token: string, teamMembershipId: number | bigint): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table(TOKENS)} SET ${column(TOKENS, "team_membership_id")} = ${teamMembershipId} WHERE ${column(TOKENS, "token")} = ${token}`,
  );
}

export { transaction };
