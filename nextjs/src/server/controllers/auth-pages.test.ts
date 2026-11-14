import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAuth } from "../auth/resolve.ts";
import { secureRedirectPageProps, rubyToI } from "../page-props/auth-pages.ts";
import type { ActionContext } from "../page-props/load-page.ts";
import { MetaTagBuilder } from "../page-props/meta-tags.ts";

import { type Chain, HandBackToRails } from "./application-controller.ts";
import {
  LOGIN_OPTIONS,
  resendCooldownSeconds,
  SECURE_REDIRECT_OPTIONS,
  SIGNUP_OPTIONS,
  teamInvitationEmail,
  TWO_FACTOR_OPTIONS,
} from "./auth-pages.ts";
import { railsRequest } from "./rails-request.ts";

const signedOut: ResolvedAuth = {
  context: { loggedInUser: null, currentSeller: null, impersonatedUser: null },
  effects: { signOut: false, signedOut: null, clearCurrentSeller: false },
  authenticatedVia: null,
};

const chainFor = (
  path: string,
  headers: Record<string, string> = {},
  session: Record<string, unknown> = {},
): Chain => ({
  request: railsRequest(
    new Request(`http://app.test.gumroad.com:31337${path}`, {
      headers: { host: "app.test.gumroad.com:31337", ...headers },
    }),
  ),
  now: new Date("2026-01-01T00:00:00Z"),
  headers: new Headers(),
  session: { data: { ...session } },
  csrfToken: "token",
  guid: null,
  auth: signedOut,
  cookies: [],
  sessionCleared: false,
  pageState: {},
  afterCookies: [],
});

beforeEach(() => {
  vi.stubEnv("RAILS_ENV", "test");
});
afterEach(() => vi.unstubAllEnvs());

describe("LoginsController#new filters", () => {
  const filters = LOGIN_OPTIONS.filters!;

  it("writes a fresh WebAuthn challenge to the session and offers it as the passkey options", async () => {
    const chain = chainFor("/login");
    const outcome = await filters(chain);

    expect(outcome).toHaveProperty("state");
    const { passkey_login_options: options } = (outcome as { state: Record<string, unknown> }).state as {
      passkey_login_options: Record<string, unknown>;
    };
    expect(options).toEqual({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      timeout: 120_000,
      extensions: {},
      allowCredentials: [],
      rpId: "test.gumroad.com",
      userVerification: "required",
    });
    expect(Object.keys(options)).toEqual([
      "challenge",
      "timeout",
      "extensions",
      "allowCredentials",
      "rpId",
      "userVerification",
    ]);
    expect(chain.session.data.webauthn_authentication_challenge).toBe(options.challenge);

    const other = chainFor("/login");
    await filters(other);
    expect(other.session.data.webauthn_authentication_challenge).not.toBe(options.challenge);
  });

  it("sends a visitor who came from another page to the login page with that page as next, without a challenge", async () => {
    const chain = chainFor("/login", { referer: "http://app.test.gumroad.com:31337/products/new?a=b c" });
    const outcome = await filters(chain);

    expect(outcome).toEqual({
      halt: {
        status: 302,
        location: "/login?next=http%3A%2F%2Fapp.test.gumroad.com%3A31337%2Fproducts%2Fnew%3Fa%3Db+c",
        rescued: false,
      },
    });
    expect(chain.session.data).not.toHaveProperty("webauthn_authentication_challenge");
  });

  it("sets the noindex header for an OAuth authorize next and refuses a JSON request before rendering", async () => {
    const chain = chainFor("/login?next=%2Foauth%2Fauthorize");
    // There is no query, so no application is looked up.
    expect(await filters(chain)).toHaveProperty("state");
    expect(chain.headers.get("x-robots-tag")).toBe("noindex");

    const json = await filters(chainFor("/login", { accept: "application/json" }));
    expect(json).toEqual({
      halt: { status: 400, body: "", contentType: "text/html", rescued: true, paramsRead: true },
    });
    expect(await filters(chainFor("/login", { accept: "application/json", "x-inertia": "true" }))).toHaveProperty(
      "state",
    );
  });

  it("redirects an unparseable next to the bare login page", async () => {
    expect(await filters(chainFor("/login?next=http%3A%2F%2Fbad+host%2Fpath"))).toEqual({
      halt: { status: 302, location: "/login", rescued: true },
    });
  });

  it("hands array and hash params back to Rails", async () => {
    await expect(filters(chainFor("/login?next[]=a"))).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("SignupController#new filters", () => {
  it("hands back a request that is not asking for html", async () => {
    await expect(SIGNUP_OPTIONS.filters!(chainFor("/signup", { accept: "application/json" }))).rejects.toBeInstanceOf(
      HandBackToRails,
    );
  });
});

describe("TwoFactorAuthenticationController#show filters", () => {
  it("sends a visitor without a pending login to the login page with the page they asked for", async () => {
    const chain = chainFor("/two-factor?next=/dashboard");
    const outcome = await TWO_FACTOR_OPTIONS.filters!(chain);

    expect(outcome).toEqual({
      halt: { status: 303, location: "/login?next=%2Ftwo-factor%3Fnext%3D%2Fdashboard", rescued: true },
    });
    expect(chain.session.data.flash).toEqual({
      discard: [],
      flashes: { warning: "Your login session expired. Please sign in again." },
    });
  });
});

describe("SecureRedirectController#new filters", () => {
  const filters = SECURE_REDIRECT_OPTIONS.filters!;

  it("sends a visitor without a payload to the home page", async () => {
    expect(await filters(chainFor("/secure_url_redirect"))).toEqual({
      halt: { status: 302, location: "/", rescued: true },
    });
    expect(await filters(chainFor("/secure_url_redirect?encrypted_payload=%20"))).toEqual({
      halt: { status: 302, location: "/", rescued: true },
    });
  });

  it("falls back to the default copy for blank params", async () => {
    const outcome = await filters(
      chainFor("/secure_url_redirect?encrypted_payload=abc&message=&field_name=%20&error_message=Nope"),
    );
    const { state } = outcome as { state: Record<string, unknown> };

    expect(secureRedirectPageProps({ state } as ActionContext)).toEqual({
      message: "Please enter the confirmation text to continue to your destination.",
      field_name: "Confirmation text",
      error_message: "Nope",
      encrypted_payload: "abc",
    });
  });
});

describe("resendCooldownSeconds", () => {
  const now = new Date("2026-01-01T00:01:00Z");
  const sentAt = Math.floor(new Date("2026-01-01T00:00:30Z").getTime() / 1000);

  it("counts down from a minute after the token was sent", () => {
    expect(resendCooldownSeconds(sentAt, now)).toBe(30);
    expect(resendCooldownSeconds(Math.floor(now.getTime() / 1000), now)).toBe(60);
  });

  it("is zero once the minute has passed or nothing was sent", () => {
    expect(resendCooldownSeconds(sentAt - 60, now)).toBe(0);
    expect(resendCooldownSeconds(null, now)).toBe(0);
    expect(resendCooldownSeconds(undefined, now)).toBe(0);
  });
});

describe("teamInvitationEmail", () => {
  it("reads the email of a team invitation path only", () => {
    expect(teamInvitationEmail("/settings/team/invitations/abc/accept?email=a%40example.com")).toBe("a@example.com");
    expect(
      teamInvitationEmail("/settings/team/invitations/abc/accept?email=a%2Bb%40example.com&email=last%40example.com"),
    ).toBe("last@example.com");
    expect(teamInvitationEmail("/settings/team/invitations/abc/accept")).toBeNull();
    expect(teamInvitationEmail("/dashboard?email=a%40example.com")).toBeNull();
    expect(teamInvitationEmail(null)).toBeNull();
  });
});

describe("rubyToI", () => {
  it("reads String#to_i", () => {
    expect(rubyToI("1234")).toBe(1234);
    expect(rubyToI(" 12abc")).toBe(12);
    expect(rubyToI("1_000")).toBe(1000);
    expect(rubyToI("-5")).toBe(-5);
    expect(rubyToI("5.9")).toBe(5);
    expect(rubyToI("abc")).toBe(0);
    expect(rubyToI(null)).toBe(0);
    expect(rubyToI(undefined)).toBe(0);
  });
});

describe("meta tag order", () => {
  it("moves the re-declared callbacks' tags behind the analytics tags", () => {
    const meta = new MetaTagBuilder();
    meta.set({ title: "t" });
    meta.set({ name: "csrf-param", content: "a" });
    meta.set({ property: "gr:google_analytics:enabled", content: "true" });
    meta.moveToEnd(meta.keys().filter((key) => key !== "title" && !key.startsWith("meta-property-gr-google")));
    expect(meta.keys()).toEqual(["title", "meta-property-gr-google_analytics-enabled", "meta-name-csrf-param"]);
  });
});
