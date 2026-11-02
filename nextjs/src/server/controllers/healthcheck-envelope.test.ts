// Replays __fixtures__/healthcheck-envelope.golden.json: the same requests through the route handlers
// must produce what Rails sent through its full middleware stack, down to the decrypted session.
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readEncryptedCookie } from "../auth/rails-cookies.ts";
import { resetRailsCacheForTesting } from "../cache/rails-cache.ts";
import { globalCsrfToken, unmaskToken } from "../page-props/csrf.ts";
import { setSubdomainRedirectorDepsForTesting } from "../services/subdomain-redirector.ts";
import { deriveRailsCookieSecrets } from "../auth/rails-cookies.ts";
import { type HealthcheckDeps, healthcheckRoute, setHealthcheckDepsForTesting } from "./healthcheck.ts";

type Cookie = { name: string; attributes: string[]; value?: string; session?: Record<string, unknown> };
type GoldenCase = {
  name: string;
  request: { method: string; url: string; headers: Record<string, string>; redirectConfig?: string };
  response: { status: number; headers: Record<string, string>; cookies: Cookie[]; body: string };
};
const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "__fixtures__/healthcheck-envelope.golden.json"), "utf8")) as {
  secretKeyBase: string;
  sessionKey: string;
  cases: GoldenCase[];
};

const VOLATILE_HEADERS = new Set(["date", "x-request-id", "x-runtime", "content-length", "set-cookie"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR_MS = 3_600_000;

const ROUTES: Record<string, ReturnType<typeof healthcheckRoute>> = {
  "/healthcheck": healthcheckRoute("index"),
  "/healthcheck/paypal_balance": healthcheckRoute("paypal_balance"),
  "/healthcheck/stripe_balance": healthcheckRoute("stripe_balance"),
  "/healthcheck/payouts": healthcheckRoute("payouts"),
};

// Nothing in Redis, as the generator leaves it.
const RECORDED_AT = new Date("2026-10-31T21:00:00Z");
const emptyRedis = { get: async () => null, zremrangebyscore: async () => 0, zcard: async () => 0 } as unknown as ReturnType<HealthcheckDeps["redis"]>;

function describeCookie(line: string, requestCsrf: string | undefined, now: number): Cookie {
  const [pair = "", ...rawAttributes] = line.split(/;\s*/);
  const index = pair.indexOf("=");
  const name = pair.slice(0, index);
  const value = decodeURIComponent(pair.slice(index + 1).replaceAll("+", " "));
  const attributes = rawAttributes.map((attribute) => {
    const [key = "", time = ""] = attribute.split("=", 2);
    return key.toLowerCase() === "expires" ? `${key}=<now+${Math.round((new Date(time).getTime() - now) / HOUR_MS)}h>` : attribute;
  });
  if (name === golden.sessionKey) {
    const session = readEncryptedCookie(deriveRailsCookieSecrets(golden.secretKeyBase), name, value) as Record<string, unknown>;
    return { name, attributes, session: normalizeSession(session, requestCsrf) };
  }
  if (name === "_gumroad_guid") return { name, attributes, value: UUID.test(value) ? "<uuid>" : value };
  return { name, attributes, value };
}

function normalizeSession(session: Record<string, unknown>, requestCsrf: string | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(session).map(([key, value]) => {
      if (key === "session_id" && typeof value === "string" && /^[0-9a-f]{32}$/.test(value)) return [key, "<hex32>"];
      if (key === "_csrf_token") return [key, value === requestCsrf ? "<request csrf token>" : /^[\w-]{43}$/.test(String(value)) ? "<new csrf token>" : value];
      return [key, value];
    }),
  );
}

describe("ApplicationController envelope around healthcheck actions", () => {
  const saved = { ...process.env };

  beforeAll(() => {
    process.env.RAILS_ENV = "test";
    process.env.SECRET_KEY_BASE = golden.secretKeyBase;
    delete process.env.REVISION_DEFAULT;
    delete process.env.ENV_IDENTIFIER_DEV;
    // The recorded session cookies carry an expiry; read them at the time they were recorded.
    vi.useFakeTimers({ toFake: ["Date"], now: RECORDED_AT });
  });

  beforeEach(() => {
    resetRailsCacheForTesting();
    setHealthcheckDepsForTesting({ redis: () => emptyRedis });
  });

  afterAll(() => {
    setHealthcheckDepsForTesting(null);
    vi.useRealTimers();
    setSubdomainRedirectorDepsForTesting(null);
    resetRailsCacheForTesting();
    process.env = saved;
  });

  it.each(golden.cases)("$name", async ({ request, response: expected }) => {
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => request.redirectConfig ?? null });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("host", url.host);
    const route = ROUTES[url.pathname]!;
    const now = Date.now();

    const response = await route[request.method as "GET" | "HEAD"](new Request(url, { method: request.method, headers }));

    const requestSession = headers
      .get("cookie")
      ?.split(/;\s*/)
      .find((pair) => pair.startsWith(`${golden.sessionKey}=`))
      ?.slice(golden.sessionKey.length + 1);
    const requestCsrf = requestSession
      ? ((readEncryptedCookie(deriveRailsCookieSecrets(golden.secretKeyBase), golden.sessionKey, decodeURIComponent(requestSession)) as Record<string, string>)
          ._csrf_token)
      : undefined;
    const cookies = response.headers.getSetCookie().map((line) => describeCookie(line, requestCsrf, now));

    // XSRF-TOKEN is the session's CSRF token, masked with a one-time pad.
    const xsrf = cookies.find((cookie) => cookie.name === "XSRF-TOKEN");
    if (xsrf) {
      const session = response.headers.getSetCookie().find((line) => line.startsWith(`${golden.sessionKey}=`))!;
      const raw = decodeURIComponent(session.split(";")[0]!.slice(golden.sessionKey.length + 1));
      const token = (readEncryptedCookie(deriveRailsCookieSecrets(golden.secretKeyBase), golden.sessionKey, raw) as Record<string, string>)._csrf_token!;
      expect(unmaskToken(xsrf.value!).equals(globalCsrfToken(token))).toBe(true);
      xsrf.value = "<masked csrf token>";
    }

    const actualHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!VOLATILE_HEADERS.has(name)) actualHeaders[name] = name === "content-security-policy" ? "<present>" : value;
    });
    expect({ status: response.status, headers: actualHeaders, cookies, body: await response.text() }).toEqual(expected);
  });
});
