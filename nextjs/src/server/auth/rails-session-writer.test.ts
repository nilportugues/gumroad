import type { User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import golden from "./__fixtures__/rails-cookies.golden.json" with { type: "json" };
import { readEncryptedCookie } from "./rails-cookies.ts";
import { railsCookieSecrets } from "./rails-session-config.ts";
import { railsSignInCookie, railsSignOutCookies } from "./rails-session-writer.ts";
import { isSameOriginRequest, safeRedirectPath } from "./redirects.ts";
import { resolveAuth } from "./resolve.ts";
import type { AuthStore } from "./store.ts";

const production = { railsEnv: "production", branchDeployment: false, domain: undefined };
const now = new Date("2026-10-31T12:00:00Z");

beforeEach(() => vi.stubEnv("SECRET_KEY_BASE", golden.secret_key_base));
afterEach(() => vi.unstubAllEnvs());

describe("railsSignInCookie", () => {
  const user = { id: 42n, encrypted_password: golden.bcrypt[0]!.hash, last_active_sessions_invalidated_at: null, flags: 1n, deleted_at: null } as User;

  it("writes a session cookie Rails reads as this user, scoped like Rails scopes it", async () => {
    const cookie = railsSignInCookie(user, "app.gumroad.com", production, now);
    expect(cookie.name).toBe("_gumroad_app_session");
    expect(cookie.options).toEqual({ domain: "gumroad.com", path: "/", httpOnly: true, secure: true, sameSite: "lax", expires: new Date("2026-11-30T12:00:00Z") });

    const session = readEncryptedCookie(railsCookieSecrets(), cookie.name, cookie.value, now) as Record<string, unknown>;
    expect(session["warden.user.user.key"]).toEqual([[42], user.encrypted_password.slice(0, 29)]);

    const store = { findUserById: async (id: bigint) => (id === 42n ? user : null) } as unknown as AuthStore;
    const { context } = await resolveAuth({ cookies: { get: (n) => (n === cookie.name ? cookie.value : undefined) }, secrets: railsCookieSecrets(), sessionCookieName: cookie.name, store, now });
    expect(context.loggedInUser).toBe(user);
  });
});

describe("railsSignOutCookies", () => {
  it("expires the session on the shared domain and Devise's host-only remember cookie", () => {
    const cookies = railsSignOutCookies("gumroad.com", production);
    expect(cookies.map((c) => [c.name, c.options.domain, c.options.expires?.getTime()])).toEqual([
      ["_gumroad_app_session", "gumroad.com", 0],
      ["remember_user_token", undefined, 0],
      ["last_viewed_dashboard", undefined, 0],
    ]);
  });
});

describe("redirect and origin guards", () => {
  const origin = "https://gumroad.com";

  it.each([
    ["/dashboard?x=1", "/dashboard?x=1"],
    ["https://gumroad.com/library", "/library"],
    ["https://evil.example.com/", "/"],
    ["//evil.example.com/path", "/"],
    ["/\\evil.example.com", "/"],
    [null, "/"],
  ])("sends %j to %j", (target, expected) => {
    expect(safeRedirectPath(target, origin)).toBe(expected);
  });

  it("accepts same-origin posts and refuses cross-site or unlabelled ones", () => {
    const post = (headers: Record<string, string>) => new Request(`${origin}/api/auth/logout`, { method: "POST", headers });
    expect(isSameOriginRequest(post({ origin }), origin)).toBe(true);
    expect(isSameOriginRequest(post({ "sec-fetch-site": "same-origin" }), origin)).toBe(true);
    expect(isSameOriginRequest(post({ origin: "https://evil.example.com" }), origin)).toBe(false);
    expect(isSameOriginRequest(post({ "sec-fetch-site": "cross-site" }), origin)).toBe(false);
    expect(isSameOriginRequest(post({}), origin)).toBe(false);
  });
});
