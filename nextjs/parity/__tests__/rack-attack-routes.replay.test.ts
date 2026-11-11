import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type FixtureRequest } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { RAILS_ONLY_KEYS, railsOnlyKey } from "../src/rails-only";
import { httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// The routes Rack::Attack throttles (config/initializers/rack_attack.rb) are not in routes.json, so Rails must receive them whole even with
// every flag that used to serve them on: a Node answer would skip the counter in Rails' Redis. One recorded request per route is sent to
// `next dev`; a stand-in Rails records what arrives, and nothing may be written. The other fixtures of these routes are skipped by their
// own replays (parity/src/rails-only.ts).
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTestFile = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const envTest = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTestFile)?.[1];
// The flags that served these routes before they left routes.json.
const ROUTE_FLAGS = [
  "nextjs_auth_signup",
  "nextjs_settings_totp_writes",
  "nextjs_settings_passkeys_writes",
  "nextjs_storefront_profile",
  "nextjs_product_page",
  "nextjs_discover",
  "nextjs_route_redirects",
  "nextjs_acme_challenge",
  "nextjs_marketing_actions",
].join(",");

// [route key, fixture]. A route without a recorded request (the /api twins of the API-host routes, product:/) is covered by the unit test.
const CASES = [
  [
    "/signup",
    "requests/auth_pages_parity_spec/authentication-pages-get-signup-renders-the-signup-page-with-the-platform-stats",
  ],
  [
    "POST /settings/totp/confirm",
    "requests/settings_totp_signed_in_spec/settings-authenticator-app-when-signed-in-confirming-the-setup-hands-a-code-for-a-pending-setup-to-rails",
  ],
  [
    "POST /settings/passkeys/registration_options",
    "requests/settings_passkeys_signed_in_spec/settings-passkeys-when-signed-in-registration-options-hands-a-seller-with-room-for-another-passkey-to-rails",
  ],
  [
    "POST /settings/passkeys",
    "requests/settings_passkeys_signed_in_spec/settings-passkeys-when-signed-in-adding-a-passkey-hands-a-registration-without-a-pending-challenge-to-rails",
  ],
  [
    "seller:/",
    "requests/storefront_profile_parity_spec/storefront-pages-the-profile-renders-a-profile-with-no-sections-and-no-products",
  ],
  ["/discover", "requests/discover_parity_spec/discover-when-signed-out-with-products-renders-the-root-page"],
  [
    "/purchases",
    "requests/route_redirects_parity_spec/route-redirects-on-the-gumroad-domain-answers-purchases-with-a-301-to-library",
  ],
  [
    "seller:/.well-known/acme-challenge/:token",
    "requests/public_files_parity_spec/public-files-get-well-known-acme-challenge-token-serves-the-staged-challenge-on-a-seller-custom-domain",
  ],
  [
    "POST /products/:product_id/marketing_actions/:id/execute.json",
    "requests/marketing_actions_signed_in_spec/product-marketing-actions-when-signed-in-as-the-seller-execute-hands-an-x-post-to-rails",
  ],
] as const;

// A controller spec records `/v2/sales.json`; the main host serves the same route as `/api/v2/sales`.
const sent = (request: FixtureRequest): FixtureRequest => ({
  ...request,
  path: String(request.path)
    .replace(/^\/v2\//u, "/api/v2/")
    .replace(/\.json$/u, ""),
});

describe.skipIf(!url)("routes Rack::Attack throttles", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: envTest("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    rails.close();
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("covers a recorded request for most throttled routes", () => {
    const covered = new Set(CASES.map(([key]) => key));
    for (const [key, fixture] of CASES) {
      const loaded = loadFixture(path.join(FIXTURES, `${fixture}.json`));
      expect(railsOnlyKey(loaded.exchanges.at(-1)!.request), fixture).toBe(key);
    }
    expect(RAILS_ONLY_KEYS.filter((key) => !covered.has(key))).toEqual([
      "product:/",
      "product:/.well-known/acme-challenge/:token",
    ]);
  });

  it.each(CASES.map(([key, fixture]) => [key, path.join(FIXTURES, `${fixture}.json`)] as const))(
    "hands %s to Rails whole",
    async (_key, file) => {
      const fixture = loadFixture(file);
      const index = fixture.exchanges.length - 1;
      handedBack.length = 0;
      const replayed = await replayFixtureExchange(fixture, index, {
        sql,
        redis: {
          reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
        },
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, loaded, now) =>
          sent(reencryptCookies(request, loaded, SECRET_KEY_BASE, now) as never),
        compare: { ignore: [] },
      });
      const request = sent(fixture.exchanges[index]!.request);
      expect(handedBack).toHaveLength(1);
      expect(handedBack[0]).toMatchObject({ method: request.method });
      expect(handedBack[0]!.url.split("?")[0]).toBe(String(request.path).split("?")[0]);
      expect(Object.keys(replayed.exchanges[0]!.actual.db)).toEqual([]);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
