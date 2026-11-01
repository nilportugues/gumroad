import { describe, expect, it, vi } from "vitest";

import { deriveRailsCookieSecrets, writeEncryptedCookie, writeSignedCookie } from "./auth/rails-cookies.ts";
import { newWardenSession } from "./auth/warden.ts";
import { createRailsRouteGate } from "./proxy-gate.ts";

const secrets = deriveRailsCookieSecrets("test-secret-key-base");
const SESSION = "_gumroad_app_session_test";

function request(cookies: Record<string, string> = {}) {
  return { method: "GET", url: new URL("https://gumroad.com/help"), headers: new Headers(), cookies: new Map(Object.entries(cookies)) };
}

function gate(isFeatureEnabled = vi.fn(async () => true), reportError = vi.fn()) {
  return {
    gate: createRailsRouteGate({ secrets: () => secrets, sessionCookieName: () => SESSION, isFeatureEnabled, reportError }),
    isFeatureEnabled,
    reportError,
  };
}

const signedInCookie = () =>
  writeEncryptedCookie(secrets, SESSION, newWardenSession({ id: 42n, encrypted_password: "$2a$10$abcdefghijklmnopqrstuv" }));

describe("railsRouteGate", () => {
  it("checks the flag with the signed-in user as the Flipper actor", async () => {
    const { gate: g, isFeatureEnabled } = gate();
    expect(await g.isFlagEnabled("nextjs_help", request({ [SESSION]: signedInCookie() }))).toBe(true);
    expect(isFeatureEnabled).toHaveBeenCalledWith("nextjs_help", "User;42");
  });

  it("checks the flag without an actor for signed-out visitors", async () => {
    const { gate: g, isFeatureEnabled } = gate();
    await g.isFlagEnabled("nextjs_help", request());
    expect(isFeatureEnabled).toHaveBeenCalledWith("nextjs_help", null);
  });

  it("reads the user from the remember cookie when the session has none", async () => {
    const { gate: g, isFeatureEnabled } = gate();
    const remember = writeSignedCookie(secrets, "remember_user_token", [[7], "salt", "1700000000.0"]);
    await g.isFlagEnabled("nextjs_help", request({ remember_user_token: remember }));
    expect(isFeatureEnabled).toHaveBeenCalledWith("nextjs_help", "User;7");
  });

  it("reports signed in only when a Rails user is present", async () => {
    const { gate: g } = gate();
    expect(await g.isSignedIn(request({ [SESSION]: signedInCookie() }))).toBe(true);
    expect(await g.isSignedIn(request())).toBe(false);
    expect(await g.isSignedIn(request({ [SESSION]: "tampered--value--x" }))).toBe(false);
  });

  it("hands a request that only a remember cookie signs in to Rails, which writes the session", async () => {
    const { gate: g } = gate();
    const remember = writeSignedCookie(secrets, "remember_user_token", [[7], "salt", "1700000000.0"]);
    expect(await g.signsInViaRememberCookie!(request({ remember_user_token: remember }))).toBe(true);
    expect(await g.signsInViaRememberCookie!(request({ remember_user_token: remember, [SESSION]: signedInCookie() }))).toBe(false);
    expect(await g.signsInViaRememberCookie!(request())).toBe(false);
  });

  it("sends the request to Rails when Flipper fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("redis down");
    });
    const { gate: g, reportError } = gate(failing);
    expect(await g.isFlagEnabled("nextjs_help", request())).toBe(false);
    expect(reportError).toHaveBeenCalled();
  });
});
