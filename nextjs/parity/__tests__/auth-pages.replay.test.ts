import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets, railsSessionCookieName } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { withoutRailsOnly } from "../src/rails-only";
import { inertiaPage } from "../src/http";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/auth_pages_parity_spec.rb: the GET renders of /login, /signup, /two-factor and
// /secure_url_redirect, signed out and signed in, recorded through the full Rack stack, so redirects,
// the session and XSRF cookies, SecureHeaders, flash and the page props are all compared. Examples
// that need a login or a pending two-factor session record the setup requests first; only the
// request under test (the last exchange) is replayed.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/auth_pages_parity_spec";
const ROUTE_FLAGS = "nextjs_auth_login,nextjs_auth_signup,nextjs_auth_two_factor,nextjs_auth_secure_redirect";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];

// Next.js owns what it renders and caches: Vite asset preloads, `vary`, and the per-response random
// values (CSP nonce, masked CSRF tokens).
const COMPARE = {
  ignore: [
    // Added by the test environment's Rack stack, not by the app.
    "response.headers.x-original-headers-class",
    // Next.js owns Cache-Control on rendered HTML (no-store).
    "response.headers.cache-control",
    // Rack::MiniProfiler's authorization cookie for team members; its token lives in the Rails process.
    "response.cookies.__profilin",
    // Masked per response.
    "response.cookies.XSRF-TOKEN.value",
    // insert_all leaves these to the database clock, which is not UTC on every machine; the recorded
    // offset is the recording machine's.
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    // Rails specs run with PaperTrail off; Next writes the version row production writes.
    "db.versions",
    // The recording and the replay stamp the row within the same second.
    "db.users.updated.*.changes.updated_at",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    // The csrf-token <meta>: index 2 on pages that keep ApplicationController's order, 7 on the login
    // and signup pages, which declare it again.
    "response.inertia.props._inertia_meta.7.content",
    "response.json.props._inertia_meta.7.content",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    // A fresh WebAuthn challenge per render (the session keeps it).
    "response.inertia.props.passkey_login_options.challenge",
    "response.json.props.passkey_login_options.challenge",
    // The cooldown counts from the time the token was sent, which the replay's clock has left behind.
    "response.inertia.props.resend_cooldown_seconds",
    "response.json.props.resend_cooldown_seconds",
  ],
};

const files = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json"));
const allCases = files.map((file) => {
  const index = loadFixture(path.join(FIXTURE_DIR, file)).exchanges.length - 1;
  return [`${file.replace(/^authentication-pages-/, "").replace(/\.json$/, "")} (#${index})`, file, index] as const;
});

// Rails serves /signup whole (Rack::Attack counts it); rack-attack-routes.replay.test.ts replays that.
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(path.join(FIXTURE_DIR, file)).exchanges[index]!.request);

describe.skipIf(!url)("Authentication pages parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      // External ids in the props (team memberships); the Rails test environment has no numeric key, which reads as 0.
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(allCases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(cases)(
    "%s",
    async (_name, file, index) => {
      const result = await replayFixtureExchange(path.join(FIXTURE_DIR, file), index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        // The server is another process, out of the replayer's reach.
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split('\n').filter((line) => /error|Error|at /.test(line)).slice(-25).join('\n');
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  // The challenge the page offers the passkey ceremony is the one the session cookie carries: the
  // POST /login/passkey that follows (still Rails) verifies against session[:webauthn_authentication_challenge].
  it("stores the passkey challenge it renders in the session cookie", async () => {
    const response = await fetch(new URL("/login", server.baseUrl), { headers: { "x-forwarded-host": "app.test.gumroad.com:31337" }, redirect: "manual" });
    expect(response.status).toBe(200);

    const page = inertiaPage(await response.text()) as unknown as { props: { passkey_login_options: { challenge: string } } };
    process.env.RAILS_ENV = "test";
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    const name = railsSessionCookieName();
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`))!;
    const raw = decodeURIComponent(cookie.slice(name.length + 1).split(";")[0]!);
    const session = readEncryptedCookie(railsCookieSecrets(), name, raw) as Record<string, unknown>;

    expect(page.props.passkey_login_options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.webauthn_authentication_challenge).toBe(page.props.passkey_login_options.challenge);
  });
});
