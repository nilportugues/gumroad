// Who a request is acting as, from the Rails cookies alone. Ports Warden's session fetch and
// Devise's rememberable strategy, ApplicationController#invalidate_session_if_necessary, and the
// Impersonate and CurrentSeller concerns, in the order Rails runs them.
import type { User } from "@prisma/client";

import type { RequestContext } from "./context.ts";
import { readEncryptedCookie, readSignedCookie, type RailsCookieSecrets } from "./rails-cookies.ts";
import { CURRENT_SELLER_COOKIE_NAME, REMEMBER_COOKIE_NAME } from "./rails-session-config.ts";
import type { AuthStore } from "./store.ts";
import { UserFlags } from "../models/user.ts";
import { parseRememberCookie, rememberCookieValid, wardenUserFromSession } from "./warden.ts";

export type CookieSource = { get(name: string): string | undefined };

export type ResolveInput = {
  cookies: CookieSource;
  secrets: RailsCookieSecrets;
  sessionCookieName: string;
  store: AuthStore;
  now?: Date;
  // LoginsController skips invalidate_session_if_necessary, so logout still finds the user.
  skipSessionInvalidation?: boolean;
};

// Rails writes cookies while resolving these (sign_out, reset_current_seller). A server component
// cannot, so the caller that can (a route handler or WS-04's middleware) acts on these instead.
export type ResolveEffects = {
  // Rails would sign_out: the session was invalidated after it was created.
  signOut: boolean;
  // What sign_out ends: the Warden user (Devise's current_user, not the impersonated one) and the
  // seller and impersonation the filters before it still saw.
  signedOut: { user: User; seller: User; impersonating: boolean } | null;
  // Rails would delete current_seller_id: it named a seller this user cannot act for.
  clearCurrentSeller: boolean;
};

export type ResolvedAuth = { context: RequestContext; effects: ResolveEffects; authenticatedVia: "session" | "remember_cookie" | null };

const SIGNED_OUT: RequestContext = { loggedInUser: null, currentSeller: null, impersonatedUser: null };

// Rails' `logged_in_user`, which every ported controller, presenter and policy means when it
// says logged_in_user. RequestContext.loggedInUser is Rails' `current_user` (the admin).
export function railsLoggedInUser(context: RequestContext): User | null {
  return context.impersonatedUser ?? context.loggedInUser;
}

export async function resolveAuth({ cookies, secrets, sessionCookieName, store, now = new Date(), skipSessionInvalidation = false }: ResolveInput): Promise<ResolvedAuth> {
  const effects: ResolveEffects = { signOut: false, signedOut: null, clearCurrentSeller: false };

  const warden = await authenticate(cookies, secrets, sessionCookieName, store, now);
  if (!warden) return { context: SIGNED_OUT, effects, authenticatedVia: null };
  const { user: currentUser, lastSignInAt, via } = warden;

  const impersonatedUser = await findImpersonatedUser(currentUser, store);
  const loggedInUser = impersonatedUser ?? currentUser;

  // verify_current_seller is registered ahead of invalidate_session_if_necessary, so a stale
  // current_seller_id cookie is dropped even when the session is about to end.
  const currentSeller = await resolveCurrentSeller(cookies, secrets, loggedInUser, store, now, effects);

  // invalidate_session_if_necessary checks logged_in_user, so an impersonated user's
  // invalidation also ends the admin's session. Kept as Rails does it.
  const invalidatedAt = loggedInUser.last_active_sessions_invalidated_at;
  if (!skipSessionInvalidation && invalidatedAt && !(lastSignInAt !== null && lastSignInAt >= Math.floor(invalidatedAt.getTime() / 1000))) {
    effects.signOut = true;
    effects.signedOut = { user: currentUser, seller: currentSeller, impersonating: impersonatedUser !== null };
    return { context: SIGNED_OUT, effects, authenticatedVia: null };
  }

  return { context: { loggedInUser: currentUser, currentSeller, impersonatedUser }, effects, authenticatedVia: via };
}

type Authenticated = { user: User; lastSignInAt: number | null; via: "session" | "remember_cookie" };

// Devise's current_user: the session's Warden key first; only when that yields no user does the
// rememberable strategy run, and its after_set_user hook stamps last_sign_in_at with now.
async function authenticate(cookies: CookieSource, secrets: RailsCookieSecrets, sessionCookieName: string, store: AuthStore, now: Date): Promise<Authenticated | null> {
  const session = readEncryptedCookie(secrets, sessionCookieName, cookies.get(sessionCookieName), now);
  const warden = wardenUserFromSession(session);
  if (warden) {
    const user = await store.findUserById(warden.userId);
    if (user) return { user, lastSignInAt: warden.lastSignInAt, via: "session" };
  }

  const remember = parseRememberCookie(readSignedCookie(secrets, REMEMBER_COOKIE_NAME, cookies.get(REMEMBER_COOKIE_NAME), now));
  if (!remember) return null;
  const user = await store.findUserById(remember.userId);
  if (!user || !rememberCookieValid(user, remember, now)) return null;
  return { user, lastSignInAt: Math.floor(now.getTime() / 1000), via: "remember_cookie" };
}

// Impersonate#impersonated_user: only team members (Gumroad staff) can impersonate, and only alive
// users can be impersonated.
async function findImpersonatedUser(currentUser: User, store: AuthStore): Promise<User | null> {
  if (!UserFlags.isSet(currentUser.flags, "is_team_member")) return null;
  const id = await store.impersonatedUserId(currentUser.id);
  if (id === null || !/^\d+$/.test(id)) return null;
  return store.findAliveUserById(BigInt(id));
}

// CurrentSeller#current_seller and #verify_current_seller.
async function resolveCurrentSeller(
  cookies: CookieSource,
  secrets: RailsCookieSecrets,
  loggedInUser: User,
  store: AuthStore,
  now: Date,
  effects: ResolveEffects,
): Promise<User> {
  const raw = cookies.get(CURRENT_SELLER_COOKIE_NAME);
  const sellerId = toId(readEncryptedCookie(secrets, CURRENT_SELLER_COOKIE_NAME, raw, now));
  const fromCookie = sellerId === null ? null : await store.findAliveUserById(sellerId);
  if (!fromCookie) {
    // cookies.delete is a no-op when the browser sent no such cookie.
    if (raw !== undefined) effects.clearCurrentSeller = true;
    return loggedInUser;
  }
  if (fromCookie.id === loggedInUser.id) return fromCookie;
  const memberships = await store.switchableMemberships(loggedInUser.id);
  if (memberships.some((m) => m.seller_id === fromCookie.id)) return fromCookie;
  effects.clearCurrentSeller = true;
  return loggedInUser;
}

function toId(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return null;
}
