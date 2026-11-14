// OauthDeviceAuthorization (app/models/oauth_device_authorization.rb): the codes of the OAuth device flow and the poll that turns an
// approved one into an access token. Only digests of the codes are stored.
import { createHash, randomInt } from "node:crypto";

import { Prisma } from "@prisma/client";

import { generateUniqueToken, insertAccessToken, type IssuedAccessToken } from "./oauth-tokens.ts";
import { transaction } from "./runtime/transaction.ts";
import { column, execute, isRecordNotUnique, selectRows, table } from "./sql.ts";

export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_REDIRECT_URI = GRANT_TYPE;
export const EXPIRES_IN_SECONDS = 600;
export const POLL_INTERVAL_SECONDS = 30;
export const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MAX_CODE_GENERATION_ATTEMPTS = 3;
const SIXTY_YEARS_IN_SECONDS = 1_893_417_120;
const MILLISECONDS_PER_SECOND = 1000;

export const STATUS_PENDING = "pending";
export const STATUS_APPROVED = "approved";
export const STATUS_DENIED = "denied";
export const STATUS_CONSUMED = "consumed";

export type PollOutcome =
  | { status: "authorization_pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired_token" }
  | { status: "access_denied" }
  | { status: "approved"; token: IssuedAccessToken };

export type DeviceAuthorizationRow = {
  id: number;
  oauth_application_id: number;
  resource_owner_id: number | null;
  access_token_id: number | null;
  device_code_digest: string;
  user_code_digest: string;
  scopes: string;
  status: string;
  expires_at: Date;
  last_polled_at: Date | null;
  poll_count: number;
  poll_interval_seconds: number;
  approved_at: Date | null;
  created_at: Date;
};

const DEVICE = "oauth_device_authorizations";
const APPLICATIONS = "oauth_applications";
const TOKENS = "oauth_access_tokens";
const GRANTS = "oauth_access_grants";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
// OauthDeviceAuthorization.digest(value.to_s)
export const digest = sha256;

// .normalize_user_code
export const normalizeUserCode = (userCode: string): string => userCode.toUpperCase().replace(/[^A-Z0-9]/gu, "");

// .format_user_code
export function formatUserCode(userCode: string): string {
  const normalized = normalizeUserCode(userCode);
  if (normalized === "") return "";
  const groups = (value: string) => value.match(/.{1,4}/gu)?.join("-") ?? "";
  return normalized.startsWith("GRD") ? `GRD-${groups(normalized.slice("GRD".length))}` : groups(normalized);
}

// SecureRandom.alphanumeric(8).upcase.scan(/.{1,4}/).join("-"): upper and lower case letters fold together.
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateUserCode(): string {
  const characters = Array.from({ length: 8 }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]!)
    .join("")
    .toUpperCase();
  return `GRD-${characters.slice(0, 4)}-${characters.slice(4)}`;
}

const wholeSeconds = (date: Date) =>
  new Date(Math.floor(date.getTime() / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND);

// `record.lock!` inside a transaction: the row is read again FOR UPDATE.
async function lockRow<T>(tableName: string, id: number): Promise<T | null> {
  const [row] = await selectRows<T>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id} LIMIT 1 FOR UPDATE`,
  );
  return row ?? null;
}

// `oauth_application.with_lock { ... }`: ActiveRecord's plain lock (no bounded wait, unlike with_application_lock).
export async function withApplicationRowLock<T>(applicationId: number, fn: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    await lockRow(APPLICATIONS, applicationId);
    return fn();
  });
}

export async function findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRow | null> {
  if (deviceCode.trim() === "") return null;
  const [row] = await selectRows<DeviceAuthorizationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_device_authorizations`.*")} FROM ${table(DEVICE)} WHERE ${column(DEVICE, "device_code_digest")} = ${digest(deviceCode)} LIMIT 1`,
  );
  return row ?? null;
}

export async function findByUserCode(userCode: string): Promise<DeviceAuthorizationRow | null> {
  const normalized = normalizeUserCode(userCode);
  if (normalized === "") return null;
  const [row] = await selectRows<DeviceAuthorizationRow>(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_device_authorizations`.*")} FROM ${table(DEVICE)} WHERE ${column(DEVICE, "user_code_digest")} = ${digest(normalized)} LIMIT 1`,
  );
  return row ?? null;
}

// .create_for!: a random device code and user code, retried when a digest collides.
export async function createFor(attributes: {
  applicationId: number;
  scopes: string;
  ipAddress: string;
  userAgent: string;
  now: Date;
}): Promise<{ deviceCode: string; userCode: string }> {
  for (let attempt = 1; ; attempt += 1) {
    const deviceCode = generateUniqueToken();
    const userCode = generateUserCode();
    try {
      await execute(
        Prisma.sql`INSERT INTO ${table(DEVICE)} (${column(DEVICE, "oauth_application_id")}, ${column(DEVICE, "device_code_digest")}, ${column(DEVICE, "user_code_digest")}, ${column(DEVICE, "scopes")}, ${column(DEVICE, "status")}, ${column(DEVICE, "expires_at")}, ${column(DEVICE, "poll_interval_seconds")}, ${column(DEVICE, "created_ip_address")}, ${column(DEVICE, "created_user_agent")}, ${column(DEVICE, "created_at")}, ${column(DEVICE, "updated_at")}) VALUES (${attributes.applicationId}, ${digest(deviceCode)}, ${digest(normalizeUserCode(userCode))}, ${attributes.scopes}, ${STATUS_PENDING}, ${new Date(attributes.now.getTime() + EXPIRES_IN_SECONDS * MILLISECONDS_PER_SECOND)}, ${POLL_INTERVAL_SECONDS}, ${attributes.ipAddress}, ${attributes.userAgent}, ${attributes.now}, ${attributes.now})`,
      );
      return { deviceCode, userCode };
    } catch (error) {
      if (!isRecordNotUnique(error) || attempt >= MAX_CODE_GENERATION_ATTEMPTS) throw error;
    }
  }
}

const expired = (row: DeviceAuthorizationRow, at: Date) => row.expires_at.getTime() <= at.getTime();

// #in_approval_grace?: the client's final poll lands at expires_at, so an approval after its previous poll needs one more interval.
const inApprovalGrace = (row: DeviceAuthorizationRow, at: Date) =>
  row.status === STATUS_APPROVED &&
  row.approved_at !== null &&
  row.approved_at.getTime() < row.expires_at.getTime() &&
  at.getTime() < row.expires_at.getTime() + row.poll_interval_seconds * MILLISECONDS_PER_SECOND;

// #access_revoked_after_creation_for?: oauth_access_tokens.revoked_at is second precision, so same-second revokes invalidate the code.
async function accessRevokedAfterCreation(row: DeviceAuthorizationRow, ownerId: number | null): Promise<boolean> {
  if (ownerId === null) return false;
  const cutoff = wholeSeconds(row.created_at);
  const [revoked] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(TOKENS)} WHERE ${column(TOKENS, "application_id")} = ${row.oauth_application_id} AND ${column(TOKENS, "resource_owner_id")} = ${ownerId} AND ${column(TOKENS, "revoked_at")} >= ${cutoff} LIMIT 1`,
  );
  if (!revoked) return false;
  const [live] = await selectRows(
    Prisma.sql`SELECT 1 AS one FROM ${table(TOKENS)} WHERE ${column(TOKENS, "application_id")} = ${row.oauth_application_id} AND ${column(TOKENS, "resource_owner_id")} = ${ownerId} AND ${column(TOKENS, "revoked_at")} IS NULL LIMIT 1`,
  );
  return !live;
}

async function updatePollMetadata(
  row: DeviceAuthorizationRow,
  poll: { ipAddress: string; userAgent: string; now: Date },
  pollIntervalSeconds: number,
): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table(DEVICE)} SET ${column(DEVICE, "last_polled_at")} = ${poll.now}, ${column(DEVICE, "last_poll_ip_address")} = ${poll.ipAddress}, ${column(DEVICE, "last_poll_user_agent")} = ${poll.userAgent}, ${column(DEVICE, "poll_count")} = ${row.poll_count + 1}, ${column(DEVICE, "poll_interval_seconds")} = ${pollIntervalSeconds}, ${column(DEVICE, "updated_at")} = ${poll.now} WHERE ${column(DEVICE, "id")} = ${row.id}`,
  );
}

// #mark_denied!
async function markDenied(
  row: DeviceAuthorizationRow,
  poll: { ipAddress: string; userAgent: string; now: Date },
): Promise<void> {
  await execute(
    Prisma.sql`UPDATE ${table(DEVICE)} SET ${column(DEVICE, "resource_owner_id")} = ${row.resource_owner_id}, ${column(DEVICE, "status")} = ${STATUS_DENIED}, ${column(DEVICE, "denied_at")} = ${poll.now}, ${column(DEVICE, "denied_ip_address")} = ${poll.ipAddress}, ${column(DEVICE, "denied_user_agent")} = ${poll.userAgent}, ${column(DEVICE, "updated_at")} = ${poll.now} WHERE ${column(DEVICE, "id")} = ${row.id}`,
  );
}

// #ensure_access_grant_exists!: `access_grants.where(...).first_or_create!`. The lookup compares the scopes as stored on the code;
// the grant's own scopes= setter normalises them.
async function ensureAccessGrantExists(row: DeviceAuthorizationRow, now: Date): Promise<void> {
  const [existing] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`oauth_access_grants`.*")} FROM ${table(GRANTS)} WHERE ${column(GRANTS, "application_id")} = ${row.oauth_application_id} AND ${column(GRANTS, "resource_owner_id")} = ${row.resource_owner_id} AND ${column(GRANTS, "scopes")} = ${row.scopes} AND ${column(GRANTS, "redirect_uri")} = ${DEVICE_REDIRECT_URI} ORDER BY ${column(GRANTS, "id")} ASC LIMIT 1`,
  );
  if (existing) return;
  const normalized = [...new Set(row.scopes.split(/[ \t\n\v\f\r]+/u).filter((scope) => scope !== ""))].join(" ");
  await execute(
    Prisma.sql`INSERT INTO ${table(GRANTS)} (${column(GRANTS, "resource_owner_id")}, ${column(GRANTS, "application_id")}, ${column(GRANTS, "token")}, ${column(GRANTS, "expires_in")}, ${column(GRANTS, "redirect_uri")}, ${column(GRANTS, "created_at")}, ${column(GRANTS, "scopes")}) VALUES (${row.resource_owner_id}, ${row.oauth_application_id}, ${generateUniqueToken()}, ${SIXTY_YEARS_IN_SECONDS}, ${DEVICE_REDIRECT_URI}, ${wholeSeconds(now)}, ${normalized})`,
  );
}

// `resource_owner`, nil when the association has no row.
async function loadOwner(ownerId: number | null): Promise<{ deleted: boolean } | null> {
  if (ownerId === null) return null;
  const [owner] = await selectRows<{ deleted_at: Date | null }>(
    Prisma.sql`SELECT ${column("users", "deleted_at")} FROM ${table("users")} WHERE ${column("users", "id")} = ${ownerId} LIMIT 1`,
  );
  return owner ? { deleted: owner.deleted_at != null } : null;
}

// #poll!, run under the application row lock and the code's own: `oauth_application.with_lock { with_lock { ... } }`.
export async function poll(
  deviceAuthorizationId: number,
  application: { id: number },
  request: { ipAddress: string; userAgent: string; now: Date },
): Promise<PollOutcome> {
  const { now } = request;
  return withApplicationRowLock(application.id, async () => {
    const row = await lockRow<DeviceAuthorizationRow>(DEVICE, deviceAuthorizationId);
    if (row === null) return { status: "expired_token" };
    if (application.id !== row.oauth_application_id || row.status === STATUS_CONSUMED)
      return { status: "expired_token" };
    if (row.status === STATUS_DENIED) return { status: "access_denied" };
    if (expired(row, now) && !inApprovalGrace(row, now)) return { status: "expired_token" };
    if (row.status === STATUS_PENDING) {
      const tooRecent =
        row.last_polled_at !== null &&
        row.last_polled_at.getTime() > now.getTime() - row.poll_interval_seconds * MILLISECONDS_PER_SECOND;
      const next = tooRecent ? row.poll_interval_seconds + SLOW_DOWN_INCREMENT_SECONDS : row.poll_interval_seconds;
      await updatePollMetadata(row, request, next);
      return tooRecent ? { status: "slow_down", interval: next } : { status: "authorization_pending" };
    }
    // An approve! racing account closure commits after closure denied the approved codes.
    const owner = await loadOwner(row.resource_owner_id);
    if (owner?.deleted || (owner !== null && (await accessRevokedAfterCreation(row, row.resource_owner_id)))) {
      await markDenied(row, request);
      return { status: "access_denied" };
    }
    await updatePollMetadata(row, request, row.poll_interval_seconds);
    await ensureAccessGrantExists(row, now);
    const token = await insertAccessToken({
      applicationId: row.oauth_application_id,
      resourceOwnerId: row.resource_owner_id,
      scopes: [...new Set(row.scopes.split(/[ \t\n\v\f\r]+/u).filter((scope) => scope !== ""))].join(" "),
      expiresIn: null,
      useRefreshToken: true,
      resource: null,
      createdAt: now,
    });
    const [created] = await selectRows<{ id: number }>(
      Prisma.sql`SELECT ${column(TOKENS, "id")} FROM ${table(TOKENS)} WHERE ${column(TOKENS, "token")} = ${token.token} LIMIT 1`,
    );
    await execute(
      Prisma.sql`UPDATE ${table(DEVICE)} SET ${column(DEVICE, "status")} = ${STATUS_CONSUMED}, ${column(DEVICE, "consumed_at")} = ${now}, ${column(DEVICE, "access_token_id")} = ${created!.id}, ${column(DEVICE, "updated_at")} = ${now} WHERE ${column(DEVICE, "id")} = ${row.id}`,
    );
    return { status: "approved", token };
  });
}

// `value.reload.revoked?` of the issued token, read under the application lock again.
export async function issuedTokenRevoked(token: IssuedAccessToken, now: Date): Promise<boolean> {
  const [row] = await selectRows<{ revoked_at: Date | null }>(
    Prisma.sql`SELECT ${column(TOKENS, "revoked_at")} FROM ${table(TOKENS)} WHERE ${column(TOKENS, "token")} = ${token.token} LIMIT 1`,
  );
  return row?.revoked_at != null && row.revoked_at.getTime() <= now.getTime();
}
