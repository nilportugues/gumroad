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

// Replays the storefront post page request specs (seller subdomain, custom domain, Gumroad blog), recorded
// through the full Rack stack, so cookies, XSRF-TOKEN and the SecureHeaders are compared. Fixtures
// with setup requests (CSRF fetch, login) replay only the last exchange.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIRS = ["parity/fixtures/requests/storefront_posts_parity_spec", "parity/fixtures/requests/storefront_post_comments_parity_spec"];
const ROUTE_FLAGS = ["nextjs_storefront_posts", "nextjs_gumroad_blog_post"].join(",");
const WARM_PATHS = ["/gr-host/seller/p/warm", "/blog/p/warm"];
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
const recaptchaKey = /^RECAPTCHA_MONEY_SITE_KEY=(.+)$/mu.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];

// Next.js owns what it renders and caches: Vite asset preloads, `vary`, and the per-response random
// values (CSP nonce, masked CSRF tokens).
const COMPARE = {
  ignore: [
    // Added by the test environment's Rack stack, not by the app.
    "response.headers.x-original-headers-class",
    // Next.js owns Cache-Control on rendered HTML (no-store).
    "response.headers.cache-control",
    // Rack::MiniProfiler's authorization cookie for team members.
    "response.cookies.__profilin",
    // Seeded as "<now-24h>"; a request that takes over a second to render reads back as "<now-1440m>".
    "response.inertia.props.recent_posts.*.published_at",
    "response.json.props.recent_posts.*.published_at",
    // Masked per response.
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.versions",
    "db.users.updated.*.changes.updated_at",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    // _inertia_meta[2] is the csrf-token <meta>
    "response.inertia.props._inertia_meta.2.content",
    // Signed with the recording app's random secret_key_base; message-verifier.test.ts pins the algorithm against Ruby.
    "response.inertia.props.products.*.analytics_script_token",
    "response.inertia.props.default_product.analytics_script_token",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
  ],
};

// The test environment renders a 404 as Rails' exception debug page; production (and Next.js) render
// public/404.html. Everything else about the response is compared.
const hasDebugPageBody = (file: string) => /-is-a-404-/u.test(file);

const cases = FIXTURE_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const exchanges = loadFixture(path.join(dir, file)).exchanges;
      return [`${path.basename(dir)}/${file.replace(/\.json$/u, "")}`, path.join(dir, file), exchanges.length - 1] as const;
    }),
);

describe.skipIf(!url)("WS-68 storefront post pages parity", () => {
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
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(recaptchaKey ? { RECAPTCHA_MONEY_SITE_KEY: recaptchaKey } : {}),
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      NEXTJS_ASSUME_SIGNED_OUT: "1",
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

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's
  // tolerance for the first fixture that hits it.
  it("warms up the routes", async () => {
    const headers = { "x-forwarded-host": "app.test.gumroad.com:31337" };
    for (const warmPath of WARM_PATHS) await fetch(new URL(warmPath, server.baseUrl), { headers, redirect: "manual" });
  }, FIRST_COMPILE_TIMEOUT_MS * 2);

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (_name, file, index) => {
      const result = await replayFixtureExchange(file, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        // The server is another process, out of the replayer's reach.
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        compare: hasDebugPageBody(path.basename(file, ".json")) ? { ...COMPARE, ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /u.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
