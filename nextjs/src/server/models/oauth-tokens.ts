// The Doorkeeper lookups behind Oauth::TokensController (doorkeeper 5.7.1). Gumroad stores tokens and client secrets as plaintext
// (no hash_token_secrets / hash_application_secrets), so a lookup is an equality the database decides, collation included.
import { timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { column, execute, selectRows, table } from "./sql.ts";

export type ApplicationRow = {
  id: number;
  uid: string;
  secret: string;
  confidential: unknown;
  mcp_dynamic_client: unknown;
};
export type AccessTokenRow = {
  id: number;
  application_id: number;
  token: string;
  expires_in: number | null;
  revoked_at: Date | null;
  created_at: Date;
  scopes: string | null;
};
export type AccessGrantRow = {
  id: number;
  application_id: number;
  expires_in: number;
  revoked_at: Date | null;
  created_at: Date;
  redirect_uri: string;
  code_challenge: string | null;
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
