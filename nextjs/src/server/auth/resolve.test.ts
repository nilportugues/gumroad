import type { TeamMembership, User } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { deriveRailsCookieSecrets, writeEncryptedCookie, writeSignedCookie } from "./rails-cookies.ts";
import { CURRENT_SELLER_COOKIE_NAME, REMEMBER_COOKIE_NAME } from "./rails-session-config.ts";
import { railsLoggedInUser, resolveAuth } from "./resolve.ts";
import type { AuthStore } from "./store.ts";
import { UserFlags } from "../models/user.ts";

const secrets = deriveRailsCookieSecrets("c".repeat(128));
const SESSION = "_gumroad_app_session_test";
const now = new Date("2026-10-31T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const HASH = "$2a$04$abcdefghijklmnopqrstuuJ0T3Kq0k2j5H3pQvR3dS9dQd1sQ6s5a";

let nextId = 1n;
function makeUser(attributes: Partial<User> = {}): User {
  return { id: nextId++, encrypted_password: HASH, deleted_at: null, flags: 1n, remember_created_at: null, last_active_sessions_invalidated_at: null, ...attributes } as User;
}

function makeStore(users: User[], { memberships = [] as TeamMembership[], impersonations = new Map<bigint, string>() } = {}): AuthStore {
  return {
    findUserById: async (id) => users.find((u) => u.id === id) ?? null,
    findAliveUserById: async (id) => users.find((u) => u.id === id && u.deleted_at === null) ?? null,
    findUserForLogin: async () => null,
    switchableMemberships: async (userId) =>
      memberships.filter((m) => m.user_id === userId && m.deleted_at === null && users.some((u) => u.id === m.seller_id && u.deleted_at === null)),
    impersonatedUserId: async (adminId) => impersonations.get(adminId) ?? null,
    clearImpersonation: async () => {},
    forgetRememberedLogins: async () => {},
  };
}

function membership(user: User, seller: User, role = "admin", attributes: Partial<TeamMembership> = {}): TeamMembership {
  return { id: nextId++, user_id: user.id, seller_id: seller.id, role, deleted_at: null, last_accessed_at: null, created_at: now, updated_at: now, ...attributes };
}

function sessionCookie(user: User, { lastSignInAt = nowSeconds as number | null, salt = HASH.slice(0, 29) } = {}): string {
  return writeEncryptedCookie(secrets, SESSION, {
    session_id: "abc",
    "warden.user.user.key": [[Number(user.id)], salt],
    ...(lastSignInAt === null ? {} : { "warden.user.user.session": { last_sign_in_at: lastSignInAt } }),
  });
}

function rememberCookie(user: User, { token = HASH.slice(0, 29), generatedAt = `${nowSeconds - 60}.5` } = {}): string {
  return writeSignedCookie(secrets, REMEMBER_COOKIE_NAME, [[Number(user.id)], token, generatedAt]);
}

async function resolve(cookies: Record<string, string>, store: AuthStore) {
  return resolveAuth({ cookies: { get: (name) => cookies[name] }, secrets, sessionCookieName: SESSION, store, now });
}

describe("resolveAuth", () => {
  it("is signed out without cookies", async () => {
    const { context, authenticatedVia } = await resolve({}, makeStore([]));
    expect(context).toEqual({ loggedInUser: null, currentSeller: null, impersonatedUser: null });
    expect(authenticatedVia).toBeNull();
  });

  it("signs in the session's Warden user, acting as themselves", async () => {
    const user = makeUser();
    const { context, authenticatedVia } = await resolve({ [SESSION]: sessionCookie(user) }, makeStore([user]));
    expect(context).toEqual({ loggedInUser: user, currentSeller: user, impersonatedUser: null });
    expect(authenticatedVia).toBe("session");
  });

  it("ignores the session salt, as User.serialize_from_session does", async () => {
    const user = makeUser();
    const { context } = await resolve({ [SESSION]: sessionCookie(user, { salt: "stale" }) }, makeStore([user]));
    expect(context.loggedInUser).toBe(user);
  });

  it("rejects a session cookie that does not decrypt", async () => {
    const user = makeUser();
    const tampered = sessionCookie(user).replace(/^./, (c) => (c === "A" ? "B" : "A"));
    expect((await resolve({ [SESSION]: tampered }, makeStore([user]))).context.loggedInUser).toBeNull();
  });

  describe("remember cookie", () => {
    it("signs in when the session has no user", async () => {
      const user = makeUser({ remember_created_at: new Date((nowSeconds - 3600) * 1000) });
      const { context, authenticatedVia } = await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user) }, makeStore([user]));
      expect(context.loggedInUser).toBe(user);
      expect(authenticatedVia).toBe("remember_cookie");
    });

    it("signs in when the session's user no longer exists", async () => {
      const gone = makeUser();
      const user = makeUser({ remember_created_at: new Date((nowSeconds - 3600) * 1000) });
      const { context } = await resolve({ [SESSION]: sessionCookie(gone), [REMEMBER_COOKIE_NAME]: rememberCookie(user) }, makeStore([user]));
      expect(context.loggedInUser).toBe(user);
    });

    it("rejects a token from before a password change", async () => {
      const user = makeUser({ remember_created_at: new Date((nowSeconds - 3600) * 1000) });
      expect((await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user, { token: "$2a$04$otherotherotherotherot" }) }, makeStore([user]))).context.loggedInUser).toBeNull();
    });

    it("rejects tokens once Devise forgot the user on sign out", async () => {
      const user = makeUser({ remember_created_at: null });
      expect((await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user) }, makeStore([user]))).context.loggedInUser).toBeNull();
    });

    it("rejects tokens older than remember_for", async () => {
      const user = makeUser({ remember_created_at: new Date("2026-01-01T00:00:00Z") });
      const generatedAt = `${Date.parse("2026-09-30T11:00:00Z") / 1000}.0`;
      expect((await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user, { generatedAt }) }, makeStore([user]))).context.loggedInUser).toBeNull();
    });

    it("rejects users without a password, where Rails' rememberable_value raises", async () => {
      const user = makeUser({ encrypted_password: "", remember_created_at: new Date((nowSeconds - 3600) * 1000) });
      expect((await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user, { token: "" }) }, makeStore([user]))).context.loggedInUser).toBeNull();
    });
  });

  describe("invalidate_session_if_necessary", () => {
    it("signs out sessions created before the invalidation", async () => {
      const user = makeUser({ last_active_sessions_invalidated_at: new Date((nowSeconds - 10) * 1000) });
      const { context, effects } = await resolve({ [SESSION]: sessionCookie(user, { lastSignInAt: nowSeconds - 11 }) }, makeStore([user]));
      expect(context.loggedInUser).toBeNull();
      expect(effects.signOut).toBe(true);
    });

    it("keeps sessions created in the same second or later", async () => {
      const user = makeUser({ last_active_sessions_invalidated_at: new Date((nowSeconds - 10) * 1000 + 999) });
      const { context } = await resolve({ [SESSION]: sessionCookie(user, { lastSignInAt: nowSeconds - 10 }) }, makeStore([user]));
      expect(context.loggedInUser).toBe(user);
    });

    it("signs out sessions with no last_sign_in_at", async () => {
      const user = makeUser({ last_active_sessions_invalidated_at: new Date(0) });
      expect((await resolve({ [SESSION]: sessionCookie(user, { lastSignInAt: null }) }, makeStore([user]))).context.loggedInUser).toBeNull();
    });

    it("lets a remember-cookie login through, which Rails stamps with the current time", async () => {
      const user = makeUser({ remember_created_at: new Date((nowSeconds - 3600) * 1000), last_active_sessions_invalidated_at: new Date((nowSeconds - 5) * 1000) });
      expect((await resolve({ [REMEMBER_COOKIE_NAME]: rememberCookie(user) }, makeStore([user]))).context.loggedInUser).toBe(user);
    });
  });

  describe("sign out", () => {
    it("names what the session was before it ended, and still drops a stale current seller", async () => {
      const user = makeUser({ last_active_sessions_invalidated_at: now });
      const store = makeStore([user]);
      const stale = writeEncryptedCookie(secrets, CURRENT_SELLER_COOKIE_NAME, 999_999);
      const { context, effects } = await resolve({ [SESSION]: sessionCookie(user, { lastSignInAt: nowSeconds - 1 }), [CURRENT_SELLER_COOKIE_NAME]: stale }, store);
      expect(context.loggedInUser).toBeNull();
      expect(effects.signedOut).toEqual({ user, seller: user, impersonating: false });
      expect(effects.clearCurrentSeller).toBe(true);
    });
  });

  describe("impersonation", () => {
    const admin = () => makeUser({ flags: UserFlags.set(1n, "is_team_member", true) });

    it("acts as the impersonated user when a team member has one in Redis", async () => {
      const staff = admin();
      const target = makeUser();
      const store = makeStore([staff, target], { impersonations: new Map([[staff.id, String(target.id)]]) });
      const { context } = await resolve({ [SESSION]: sessionCookie(staff) }, store);
      expect(context).toEqual({ loggedInUser: staff, currentSeller: target, impersonatedUser: target });
      expect(railsLoggedInUser(context)).toBe(target);
    });

    it("ignores the Redis key for users who are not team members", async () => {
      const user = makeUser();
      const target = makeUser();
      const store = makeStore([user, target], { impersonations: new Map([[user.id, String(target.id)]]) });
      expect((await resolve({ [SESSION]: sessionCookie(user) }, store)).context.impersonatedUser).toBeNull();
    });

    it("does not impersonate deleted users", async () => {
      const staff = admin();
      const target = makeUser({ deleted_at: now });
      const store = makeStore([staff, target], { impersonations: new Map([[staff.id, String(target.id)]]) });
      expect((await resolve({ [SESSION]: sessionCookie(staff) }, store)).context.impersonatedUser).toBeNull();
    });

    it("signs the admin out when the impersonated user's sessions were invalidated", async () => {
      const staff = admin();
      const target = makeUser({ last_active_sessions_invalidated_at: now });
      const store = makeStore([staff, target], { impersonations: new Map([[staff.id, String(target.id)]]) });
      expect((await resolve({ [SESSION]: sessionCookie(staff, { lastSignInAt: nowSeconds - 1 }) }, store)).effects.signOut).toBe(true);
    });
  });

  describe("current seller", () => {
    const sellerCookie = (seller: User) => writeEncryptedCookie(secrets, CURRENT_SELLER_COOKIE_NAME, Number(seller.id));

    it("switches to a seller the user is a team member of", async () => {
      const member = makeUser();
      const seller = makeUser();
      const store = makeStore([member, seller], { memberships: [membership(member, seller)] });
      const { context, effects } = await resolve({ [SESSION]: sessionCookie(member), [CURRENT_SELLER_COOKIE_NAME]: sellerCookie(seller) }, store);
      expect(context.currentSeller).toBe(seller);
      expect(effects.clearCurrentSeller).toBe(false);
    });

    it("falls back to the user, and clears the cookie, after the membership is deleted", async () => {
      const member = makeUser();
      const seller = makeUser();
      const store = makeStore([member, seller], { memberships: [membership(member, seller, "admin", { deleted_at: now })] });
      const { context, effects } = await resolve({ [SESSION]: sessionCookie(member), [CURRENT_SELLER_COOKIE_NAME]: sellerCookie(seller) }, store);
      expect(context.currentSeller).toBe(member);
      expect(effects.clearCurrentSeller).toBe(true);
    });

    it("falls back to the user when the seller account is deleted", async () => {
      const member = makeUser();
      const seller = makeUser({ deleted_at: now });
      const store = makeStore([member, seller], { memberships: [membership(member, seller)] });
      const { context, effects } = await resolve({ [SESSION]: sessionCookie(member), [CURRENT_SELLER_COOKIE_NAME]: sellerCookie(seller) }, store);
      expect(context.currentSeller).toBe(member);
      expect(effects.clearCurrentSeller).toBe(true);
    });

    it("leaves current_seller_id alone when the visitor is signed out", async () => {
      const seller = makeUser();
      const { context, effects } = await resolve({ [CURRENT_SELLER_COOKIE_NAME]: sellerCookie(seller) }, makeStore([seller]));
      expect(context.currentSeller).toBeNull();
      expect(effects.clearCurrentSeller).toBe(false);
    });
  });
});
