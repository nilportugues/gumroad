// Devise and Warden's sign-in and sign-out for the :user scope, as the mutations of the authentication pages perform them:
// the renewed session, the remembered login, the tracked sign-in fields, the two-factor bookkeeping and the guest-cart check.
import { randomBytes } from "node:crypto";

import { authenticatableSalt } from "../auth/devise-password.ts";
import { writeEncryptedCookie, writeSignedCookie } from "../auth/rails-cookies.ts";
import {
  DASHBOARD_PREFERENCE_COOKIE_NAME,
  railsCookieSecrets,
  railsSessionCookieOptions,
  REMEMBER_COOKIE_NAME,
} from "../auth/rails-session-config.ts";
import { prismaAuthStore } from "../auth/store.ts";
import { WARDEN_SCOPE_SESSION_KEY, WARDEN_USER_KEY } from "../auth/warden.ts";
import { encrypt as obfuscateId } from "../../lib/obfuscate-ids.ts";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { getNamespacedRedis } from "../infra/redis.ts";
import { advance } from "../models/concerns/ruby-time.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { Users, type UserRecord } from "../models/user.ts";
import { passkeysSetupPending } from "../page-props/signed-in/reads.ts";
import { type GuestCartMerge, mergeGuestCart, planGuestCartMerge } from "../services/merge-carts-service.ts";
import { allDomain, type Chain, HandBackToRails } from "./application-controller.ts";
import { deleteCookieHeader, deletesCookie } from "./signed-in-filters.ts";
import { setCookieHeader } from "./rack-cookies.ts";
import { readEncryptedCookie } from "../auth/rails-cookies.ts";

const SESSION_ID_BYTES = 16;
const TWO_FACTOR_COOKIE_NAME_PREFIX = "_gumroad_two_factor_";
const TWO_FACTOR_COOKIE_KEY_HEX_LENGTH = 13;
const PROMPT_PASSKEY_SETUP_SESSION_KEY = "prompt_passkey_setup";
const MOBILE_APP_COOKIE = "is_gumroad_mobile_app";
const GUID_COOKIE = "_gumroad_guid";
// 2.months.to_i, the lifetime of the Redis marker of an IP that passed two-factor authentication.
const TWO_FACTOR_AUTH_IP_SECONDS = 5_259_492;

// Datetime(0) columns: Rails truncates the assigned Time to whole seconds.
const toSeconds = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

// Devise's `sign_in`: Warden renews the session id, stores the user and the sign-in time, and the after_set_user hooks run
// (Rememberable, then Trackable). `remember` is `user.remember_me`; the cookie is returned for the response.
export async function signIn(chain: Chain, user: UserRecord, { remember, remoteIp }: { remember: boolean; remoteIp: string }): Promise<string[]> {
  const { session, request, now } = chain;
  const cookies: string[] = [];
  const nowSeconds = Math.floor(now.getTime() / 1000);

  session.data.session_id = randomBytes(SESSION_ID_BYTES).toString("hex");
  session.data[WARDEN_USER_KEY] = [[Number(user.get("id"))], authenticatableSalt(user.get("encrypted_password"))];
  session.data[WARDEN_SCOPE_SESSION_KEY] = { last_sign_in_at: nowSeconds };

  if (remember) {
    // Rememberable#remember_me!
    if (user.get("remember_created_at") == null) {
      user.set("remember_created_at", toSeconds(now));
      await Users.save(user, { validate: false, now: () => now });
    }
    const expires = advance(now, { months: 1 });
    const options = railsSessionCookieOptions(request.host);
    const value = [[Number(user.get("id"))], authenticatableSalt(user.get("encrypted_password")), (now.getTime() / 1000).toFixed(6)];
    cookies.push(
      setCookieHeader(REMEMBER_COOKIE_NAME, {
        value: writeSignedCookie(railsCookieSecrets(), REMEMBER_COOKIE_NAME, value, { expiresAt: expires }),
        domain: allDomain(request.host),
        path: "/",
        expires,
        secure: options.secure,
        httpOnly: true,
        sameSite: "lax",
      }),
    );
  }

  // Trackable#update_tracked_fields!
  const current = toSeconds(now);
  user.set("last_sign_in_at", user.get("current_sign_in_at") ?? current);
  user.set("current_sign_in_at", current);
  user.set("last_sign_in_ip", user.get("current_sign_in_ip") ?? remoteIp);
  user.set("current_sign_in_ip", remoteIp);
  user.set("sign_in_count", (user.get("sign_in_count") ?? 0) + 1);
  await Users.save(user, { validate: false, now: () => now });
  return cookies;
}

// Devise's `sign_out` for a signed-in user: forget_me!, the remember cookie, then the session is reset. Rails mints a new CSRF
// token for the response that follows.
export async function signOutUser(chain: Chain, user: { id: bigint }): Promise<string[]> {
  const { request, session, now } = chain;
  const cookies: string[] = [];
  await prismaAuthStore.forgetRememberedLogins(user.id, now);
  if (deletesCookie(request, REMEMBER_COOKIE_NAME)) cookies.push(deleteCookieHeader(REMEMBER_COOKIE_NAME, { domain: allDomain(request.host), httpOnly: true }));
  session.data = { session_id: randomBytes(SESSION_ID_BYTES).toString("hex") };
  chain.csrfToken = randomBytes(32).toString("base64url");
  chain.sessionCleared = false;
  return cookies;
}

// DashboardPreference#clear_dashboard_preference
export function clearDashboardPreference(chain: Chain): string[] {
  return deletesCookie(chain.request, DASHBOARD_PREFERENCE_COOKIE_NAME) ? [deleteCookieHeader(DASHBOARD_PREFERENCE_COOKIE_NAME, { domain: undefined })] : [];
}

// `merge_guest_cart_with_user_cart` merges the cart of this browser into the user's (services/merge-carts-service.ts). The plan reads
// and hands back what the port cannot merge before the sign-in writes anything; the merge runs after the sign-in, as in Rails.
export function planGuestCart(chain: Chain, user: UserRecord): Promise<GuestCartMerge | null> {
  return planGuestCartMerge(chain.request.cookies.get(GUID_COOKIE), { id: user.get("id"), email: user.get("email") ?? null });
}

export async function mergeGuestCartWithUserCart(chain: Chain, plan: GuestCartMerge | null): Promise<void> {
  if (plan !== null) await mergeGuestCart(plan, chain.now);
}

// A guest cart with products goes to Rails when the user is not known yet (the password reset), before anything is written.
export async function assertNoGuestCart(chain: Chain): Promise<void> {
  const guid = chain.request.cookies.get(GUID_COOKIE);
  if (!guid) return;
  const rows = await selectRows<{ id: bigint }>(
    Prisma.sql`SELECT 1 AS id FROM ${table("carts")} INNER JOIN ${table("cart_products")} ON ${column("cart_products", "cart_id")} = ${column("carts", "id")} WHERE ${column("carts", "browser_guid")} = ${guid} AND ${column("carts", "user_id")} IS NULL AND ${column("carts", "deleted_at")} IS NULL AND ${column("cart_products", "deleted_at")} IS NULL LIMIT 1`,
  );
  if (rows.length > 0) throw new HandBackToRails("a guest cart to merge");
}

// ApplicationController#refresh_passkey_setup_prompt
export async function refreshPasskeySetupPrompt(chain: Chain, user: UserRecord): Promise<void> {
  const mobileApp = chain.request.cookies.get(MOBILE_APP_COOKIE);
  if (!mobileApp && (await passkeysSetupPending(user.get("id")))) chain.session.data[PROMPT_PASSKEY_SETUP_SESSION_KEY] = Number(user.get("id"));
  else delete chain.session.data[PROMPT_PASSKEY_SETUP_SESSION_KEY];
}

// TwoFactorAuthentication#two_factor_authentication_cookie_key
function twoFactorCookieKey(user: UserRecord): string {
  const sha = createHash("sha256").update(obfuscateId(user.get("external_id") ?? "")).digest("hex");
  return `${TWO_FACTOR_COOKIE_NAME_PREFIX}${sha.slice(0, TWO_FACTOR_COOKIE_KEY_HEX_LENGTH)}`;
}

const twoFactorAuthIpKey = (userId: bigint, remoteIp: string) => `auth_ip_${userId}_${remoteIp}`;

// TwoFactorAuthenticationValidator#set_two_factor_auth_cookie
export function twoFactorAuthCookie(user: UserRecord, now: Date): string {
  const expires = advance(now, { months: 2 });
  const name = twoFactorCookieKey(user);
  return setCookieHeader(name, {
    value: writeEncryptedCookie(railsCookieSecrets(), name, `${user.get("id")},${Math.floor(expires.getTime() / 1000)}`, { expiresAt: expires }),
    path: "/",
    expires,
    httpOnly: true,
    sameSite: "lax",
  });
}

// TwoFactorAuthenticationValidator#skip_two_factor_authentication?'s checks after the flag: a remembered browser (whose cookie is
// refreshed) or a remembered IP.
export async function rememberedTwoFactor(chain: Chain, user: UserRecord, remoteIp: string): Promise<{ skip: boolean; cookies: string[] }> {
  const raw = chain.request.cookies.get(twoFactorCookieKey(user));
  const value = raw ? readEncryptedCookie(railsCookieSecrets(), twoFactorCookieKey(user), raw, chain.now) : null;
  if (typeof value === "string" && value !== "") {
    const [userId, expiresAt] = value.split(",").map((part) => Number.parseInt(part, 10));
    if (userId === Number(user.get("id")) && (expiresAt ?? 0) * 1000 > chain.now.getTime()) return { skip: true, cookies: [twoFactorAuthCookie(user, chain.now)] };
  }
  const seen = await getNamespacedRedis("two_factor_auth_redis_namespace").get(twoFactorAuthIpKey(user.get("id"), remoteIp));
  return { skip: seen !== null && seen !== "", cookies: [] };
}

// User#add_two_factor_authenticated_ip!
export async function addTwoFactorAuthenticatedIp(user: UserRecord, remoteIp: string): Promise<void> {
  await getNamespacedRedis("two_factor_auth_redis_namespace").set(twoFactorAuthIpKey(user.get("id"), remoteIp), "true", "EX", TWO_FACTOR_AUTH_IP_SECONDS);
}
