// The Set-Cookie side of the bridge: sign a user into Rails, or clear what Rails' sign-out clears.
import type { User } from "@prisma/client";

import { writeEncryptedCookie } from "./rails-cookies.ts";
import {
  DASHBOARD_PREFERENCE_COOKIE_NAME,
  railsCookieSecrets,
  railsEnv,
  railsSessionCookieName,
  railsSessionCookieOptions,
  railsSessionExpiresAt,
  REMEMBER_COOKIE_NAME,
  type CookieOptions,
  type RailsEnv,
} from "./rails-session-config.ts";
import { newWardenSession } from "./warden.ts";

export type CookieToSet = { name: string; value: string; options: CookieOptions };

// Rails 8 sends this for cookies.delete: empty value, expired, same domain and path.
const EXPIRED = new Date(0);

// The cookie Rails' sign_in leaves, so a login on Next is a login on Rails too.
export function railsSignInCookie(user: Pick<User, "id" | "encrypted_password">, host: string, env: RailsEnv = railsEnv(), now = new Date()): CookieToSet {
  const expires = railsSessionExpiresAt(now, env);
  const name = railsSessionCookieName(env);
  return {
    name,
    value: writeEncryptedCookie(railsCookieSecrets(), name, newWardenSession(user, now), { expiresAt: expires }),
    options: { ...railsSessionCookieOptions(host, env), expires },
  };
}

// Devise's sign_out plus LoginsController's clear_dashboard_preference. current_seller_id is kept on
// purpose: Rails leaves it so the next login lands on the same team account.
export function railsSignOutCookies(host: string, env: RailsEnv = railsEnv()): CookieToSet[] {
  const session = railsSessionCookieOptions(host, env);
  const hostOnly: CookieOptions = { path: "/", httpOnly: false, secure: false, sameSite: "lax", expires: EXPIRED };
  return [
    { name: railsSessionCookieName(env), value: "", options: { ...session, expires: EXPIRED } },
    { name: REMEMBER_COOKIE_NAME, value: "", options: { ...hostOnly, httpOnly: true } },
    { name: DASHBOARD_PREFERENCE_COOKIE_NAME, value: "", options: hostOnly },
  ];
}
