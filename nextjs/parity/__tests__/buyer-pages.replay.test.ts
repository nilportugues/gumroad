import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";

import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/buyer_pages_parity_spec.rb: the GET renders of /login, /signup, /two-factor and
// /secure_url_redirect, signed out and signed in, recorded through the full Rack stack, so redirects,
// the session and XSRF cookies, SecureHeaders, flash and the page props are all compared. Examples
// that need a login or a pending two-factor session record the setup requests first; only the
// request under test (the last exchange) is replayed.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/buyer_pages_parity_spec";
const ROUTE_FLAGS = "nextjs_buyer_password_new,nextjs_buyer_password_edit,nextjs_buyer_subscription_magic_link,nextjs_buyer_invoice_confirm,nextjs_buyer_wishlists,nextjs_buyer_wishlists_following,nextjs_buyer_reviews,nextjs_buyer_library";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const deviseKey = /^DEVISE_SECRET_KEY="?([^"\n]+)"?$/m.exec(envTest)?.[1];
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
  ],
};

const files = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json"));
const cases = files.map((file) => {
  const index = loadFixture(path.join(FIXTURE_DIR, file)).exchanges.length - 1;
  return [`${file.replace(/^buyer-pages-/, "").replace(/\.json$/, "")} (#${index})`, file, index] as const;
});

describe.skipIf(!url)("Buyer pages parity", () => {
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
      ...(deviseKey ? { DEVISE_SECRET_KEY: deviseKey } : {}),
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
    expect(cases.length).toBeGreaterThanOrEqual(10);
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
        // The test environment answers a missing record with the debug exceptions page, production with public/404.html.
        compare: file.includes("404") ? { ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
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
});
