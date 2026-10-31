import { describe, expect, it } from "vitest";

import { railsSessionCookieDomain, railsSessionCookieName } from "./rails-session-config";
import { monthsBefore, newWardenSession, wardenUserFromSession } from "./warden";

const env = (railsEnv: string, branchDeployment = false, domain?: string) => ({ railsEnv, branchDeployment, domain });

describe("session_store.rb parity", () => {
  it.each([
    [env("production"), "_gumroad_app_session"],
    [env("staging"), "_gumroad_app_session_staging"],
    [env("development"), "_gumroad_app_session_development"],
    [env("test"), "_gumroad_app_session_test"],
    // Digest::SHA256.hexdigest("pr-123.staging.gumroad.com")[0..31]
    [env("staging", true, "pr-123.staging.gumroad.com"), "_gumroad_app_session_7c4d9260af3b5e1a33d16fe1ad886aef"],
  ])("names the session cookie for %j", (input, expected) => {
    expect(railsSessionCookieName(input)).toBe(expected);
  });

  it.each([
    ["gumroad.com", env("production"), "gumroad.com"],
    ["app.gumroad.com", env("production"), "gumroad.com"],
    ["seller.gumroad.com:443", env("production"), "gumroad.com"],
    ["seller.staging.gumroad.com", env("staging"), "staging.gumroad.com"],
    ["127.0.0.1", env("development"), undefined],
    ["localhost", env("development"), undefined],
    ["anything.example.com", env("staging", true, "pr-1.staging.gumroad.com"), ".pr-1.staging.gumroad.com"],
  ])("scopes the cookie on %s to %s", (host, input, expected) => {
    expect(railsSessionCookieDomain(host, input)).toBe(expected);
  });
});

describe("warden session", () => {
  it("reads the id from Devise's [[id], salt] key", () => {
    expect(wardenUserFromSession({ "warden.user.user.key": [[42], "salt"], "warden.user.user.session": { last_sign_in_at: 5 } })).toEqual({
      userId: 42n,
      salt: "salt",
      lastSignInAt: 5,
    });
  });

  it("ignores sessions without a usable user key", () => {
    expect(wardenUserFromSession(null)).toBeNull();
    expect(wardenUserFromSession({ verify_two_factor_auth_for: 42 })).toBeNull();
    expect(wardenUserFromSession({ "warden.user.user.key": [["abc"], "salt"] })).toBeNull();
  });

  it("writes a session Rails reads back as signed in", () => {
    const session = newWardenSession({ id: 42n, encrypted_password: "$2a$11$abcdefghijklmnopqrstuvwxyz0123" }, new Date(1_700_000_000_000));
    expect(session.session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(wardenUserFromSession(session)).toEqual({ userId: 42n, salt: "$2a$11$abcdefghijklmnopqrstuv", lastSignInAt: 1_700_000_000 });
  });

  it.each([
    ["2026-10-31T12:00:00Z", "2026-09-30T12:00:00.000Z"],
    ["2026-03-31T00:00:00Z", "2026-02-28T00:00:00.000Z"],
    ["2028-03-30T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["2026-01-15T08:00:00Z", "2025-12-15T08:00:00.000Z"],
  ])("goes one month back from %s like ActiveSupport", (now, expected) => {
    expect(monthsBefore(new Date(now), 1).toISOString()).toBe(expected);
  });
});
