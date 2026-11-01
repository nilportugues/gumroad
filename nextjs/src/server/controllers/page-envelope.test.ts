import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRailsCookieSecrets, readEncryptedCookie, writeEncryptedCookie } from "../auth/rails-cookies.ts";
import { filterPartialProps } from "../page-props/load-page.ts";
import { railsJson } from "../page-props/inertia-json.ts";
import { matchPagePath } from "../page-props/pages.ts";
import { decodeRenderState, encodeRenderState } from "../page-props/render-state.ts";
import { setSubdomainRedirectorDepsForTesting } from "../services/subdomain-redirector.ts";
import { pageEnvelope } from "./application-controller.ts";

const SECRET_KEY_BASE = "page-envelope-secret-key-base";
const SESSION_COOKIE = "_gumroad_app_session_test";
const secrets = () => deriveRailsCookieSecrets(SECRET_KEY_BASE);

const sessionRequest = (session: Record<string, unknown>) => {
  const cookie = encodeURIComponent(writeEncryptedCookie(secrets(), SESSION_COOKIE, session));
  return new Request("http://app.test.gumroad.com:31337/help/article/10-dealing-with-vat", {
    headers: { host: "app.test.gumroad.com:31337", cookie: `${SESSION_COOKIE}=${cookie}` },
  });
};

const committedSession = (headers: Headers) => {
  const line = headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))!;
  return readEncryptedCookie(secrets(), SESSION_COOKIE, decodeURIComponent(line.split(";")[0]!.slice(SESSION_COOKIE.length + 1))) as Record<string, unknown>;
};

describe("pageEnvelope", () => {
  const saved = { ...process.env };

  beforeAll(() => {
    process.env.RAILS_ENV = "test";
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    delete process.env.REVISION_DEFAULT;
    delete process.env.ENV_IDENTIFIER_DEV;
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
  });

  afterAll(() => {
    setSubdomainRedirectorDepsForTesting(null);
    process.env = saved;
  });

  it("hands the render the session's CSRF token, flash and inertia_errors, and consumes the last two", async () => {
    const envelope = await pageEnvelope(
      sessionRequest({
        session_id: "a".repeat(32),
        _csrf_token: "csrf-token-from-session",
        flash: { discard: [], flashes: { alert: "Nope" } },
        inertia_errors: { email: "is invalid" },
        inertia_clear_history: true,
        mobile_param: "1",
      }),
    );
    if ("response" in envelope) throw new Error("expected an envelope");

    expect(envelope.renderState).toEqual({
      csrfToken: "csrf-token-from-session",
      flash: { alert: "Nope" },
      inertiaErrors: { email: "is invalid" },
      mobileParam: "1",
      mobileAppWebView: undefined,
      clearHistory: true,
    });
    expect(committedSession(envelope.headers)).toMatchObject({ _csrf_token: "csrf-token-from-session", flash: null });
    expect(committedSession(envelope.headers)).not.toHaveProperty("inertia_errors");
    expect(committedSession(envelope.headers)).not.toHaveProperty("inertia_clear_history");
  });

  it("sets what Rails sets on an Inertia HTML response", async () => {
    const envelope = await pageEnvelope(new Request("http://app.test.gumroad.com:31337/help", { headers: { host: "app.test.gumroad.com:31337" } }));
    if ("response" in envelope) throw new Error("expected an envelope");

    expect(envelope.headers.get("x-gr")).toBe("DEV");
    expect(envelope.headers.get("x-revision")).toBe("no-revision");
    expect(envelope.headers.get("vary")).toBe("X-Inertia, Origin");
    expect(envelope.headers.get("content-security-policy")).toBeTruthy();
    expect(envelope.headers.getSetCookie().map((cookie) => cookie.split("=")[0])).toEqual(["_gumroad_guid", "XSRF-TOKEN", SESSION_COOKIE]);
  });

  it("round-trips the render state through the header", async () => {
    const state = { csrfToken: "t", flash: { notice: "Hi" }, inertiaErrors: {}, mobileParam: null, mobileAppWebView: true, promptPasskeySetup: 7, clearHistory: false };
    expect(decodeRenderState(encodeRenderState(state))).toEqual(state);
    expect(decodeRenderState("not base64 json")).toBeNull();
    expect(decodeRenderState(null)).toBeNull();
  });
});

describe("filterPartialProps", () => {
  const props = { errors: {}, title: "t", article: { title: "a", slug: "s" }, domain_settings: { scheme: "http", app_domain: "d" } };
  const headers = (init: Record<string, string>) => new Headers({ "x-inertia-partial-component": "C", ...init });

  it("keeps everything unless the request names this component", () => {
    expect(filterPartialProps(props, "C", new Headers({ "x-inertia-partial-data": "title" }))).toBe(props);
    expect(filterPartialProps(props, "Other", headers({ "x-inertia-partial-data": "title" }))).toBe(props);
  });

  it("keeps the requested paths and always errors", () => {
    expect(filterPartialProps(props, "C", headers({ "x-inertia-partial-data": "title,article.slug" }))).toEqual({
      errors: {},
      title: "t",
      article: { slug: "s" },
    });
  });

  it("drops the excluded paths", () => {
    expect(filterPartialProps(props, "C", headers({ "x-inertia-partial-except": "article,domain_settings.scheme" }))).toEqual({
      errors: {},
      title: "t",
      domain_settings: { app_domain: "d" },
    });
  });
});

describe("railsJson", () => {
  it("escapes HTML and the JS line separators like ActiveSupport", () => {
    const separators = String.fromCharCode(0x2028, 0x2029);
    const escape = (code: string) => String.fromCharCode(92) + code;
    const expected = [escape("u003c"), "b", escape("u003e"), escape("u0026"), escape("u003c"), "/b", escape("u003e"), escape("u2028"), escape("u2029")];
    expect(railsJson({ a: `<b>&</b>${separators}` })).toBe(`{"a":"${expected.join("")}"}`);
  });
});

describe("matchPagePath", () => {
  it("finds the page and its params", () => {
    expect(matchPagePath("/help/article/10-dealing-with-vat")).toEqual({ pattern: "/help/article/:slug", params: { slug: "10-dealing-with-vat" } });
    expect(matchPagePath("/help/article")).toEqual({ pattern: "/help/article", params: {} });
    expect(matchPagePath("/help/category/x%20y")?.params).toEqual({ slug: "x y" });
  });

  it("does not match a format suffix or another path", () => {
    expect(matchPagePath("/help/article/10-dealing-with-vat.html")).toBeNull();
    expect(matchPagePath("/discover")).toBeNull();
  });
});
