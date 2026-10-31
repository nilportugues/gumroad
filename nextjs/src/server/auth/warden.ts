// What Warden and Devise keep in the Rails session and remember cookie for the :user scope.
import { randomBytes, timingSafeEqual } from "node:crypto";

import { authenticatableSalt } from "./devise-password";

export const WARDEN_USER_KEY = "warden.user.user.key";
export const WARDEN_SCOPE_SESSION_KEY = "warden.user.user.session";
const REMEMBER_FOR_MONTHS = 1; // config.remember_for in devise.rb
const SESSION_ID_BYTES = 16;

export type WardenSession = { userId: bigint; salt: unknown; lastSignInAt: number | null };

// Devise serializes `[record.to_key, record.authenticatable_salt]`. User.serialize_from_session
// accepts a bare id too and never checks the salt, so neither do we.
export function wardenUserFromSession(session: unknown): WardenSession | null {
  if (!isRecord(session)) return null;
  const key = session[WARDEN_USER_KEY];
  if (!Array.isArray(key) || key.length === 0) return null;
  const [idPart, salt] = key;
  const userId = toId(Array.isArray(idPart) ? idPart[0] : idPart);
  if (userId === null) return null;
  const scoped = session[WARDEN_SCOPE_SESSION_KEY];
  const lastSignInAt = isRecord(scoped) ? toInteger(scoped.last_sign_in_at) : null;
  return { userId, salt, lastSignInAt };
}

// A fresh session as Devise's sign_in plus the after_set_user hook in devise_hooks.rb leave it.
export function newWardenSession(user: { id: bigint; encrypted_password: string | null }, now = new Date()): Record<string, unknown> {
  return {
    session_id: randomBytes(SESSION_ID_BYTES).toString("hex"),
    [WARDEN_USER_KEY]: [[Number(user.id)], authenticatableSalt(user.encrypted_password)],
    [WARDEN_SCOPE_SESSION_KEY]: { last_sign_in_at: Math.floor(now.getTime() / 1000) },
  };
}

export type RememberCookie = { userId: bigint; token: unknown; generatedAt: unknown };

// Devise's serialize_into_cookie: `[record.to_key, rememberable_value, Time.now.utc.to_f.to_s]`.
export function parseRememberCookie(value: unknown): RememberCookie | null {
  if (!Array.isArray(value)) return null;
  const [idPart, token, generatedAt] = value;
  const userId = toId(Array.isArray(idPart) ? idPart[0] : idPart);
  return userId === null ? null : { userId, token, generatedAt };
}

type RememberableUser = { encrypted_password: string | null; remember_created_at: Date | null };

// Devise::Models::Rememberable#remember_me?. Unlike the session, this checks the salt, so changing
// the password ends every remembered login.
export function rememberCookieValid(user: RememberableUser, cookie: RememberCookie, now = new Date()): boolean {
  const generatedAt = parseGeneratedAt(cookie.generatedAt);
  if (generatedAt === null) return false;
  if (!(monthsBefore(now, REMEMBER_FOR_MONTHS).getTime() < generatedAt)) return false;
  if (!(generatedAt > (user.remember_created_at ?? now).getTime())) return false;
  // rememberable_value raises in Rails when the salt is blank (no password set); fail closed.
  const salt = authenticatableSalt(user.encrypted_password);
  if (!salt || typeof cookie.token !== "string" || !cookie.token) return false;
  const a = Buffer.from(salt, "utf8");
  const b = Buffer.from(cookie.token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Time.at(float) for "1700000000.123456"; Time.parse for the JSON timestamps older Devise wrote.
function parseGeneratedAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (/^\d+\.\d+$/.test(value)) return Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ActiveSupport's `n.months.ago`: same day n months back, clamped to that month's last day.
export function monthsBefore(now: Date, months: number): Date {
  const result = new Date(now.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function toId(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return null;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+/.test(value)) return parseInt(value, 10);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
