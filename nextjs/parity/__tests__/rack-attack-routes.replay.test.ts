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
  "nextjs_auth_login_writes",
  "nextjs_auth_two_factor_writes",
  "nextjs_auth_passwords",
  "nextjs_settings_main_writes",
  "nextjs_settings_totp_writes",
  "nextjs_settings_passkeys_writes",
  "nextjs_storefront_profile",
  "nextjs_product_page",
  "nextjs_discover",
  "nextjs_route_redirects",
  "nextjs_users_profile_routes",
  "nextjs_links_search",
  "nextjs_public_lookup_data",
  "nextjs_checkout_offer_codes",
  "nextjs_acme_challenge",
  "nextjs_purchases_public_guards",
  "nextjs_communities_writes",
  "nextjs_comments_writes",
  "nextjs_marketing_actions",
].join(",");

// [route key, fixture]. A route without a recorded request (the /api twins of the API-host routes, product:/) is covered by the unit test.
const CASES = [
  [
    "/signup",
    "requests/auth_pages_parity_spec/authentication-pages-get-signup-renders-the-signup-page-with-the-platform-stats",
  ],
  ["POST /login", "requests/auth_mutations_parity_spec/authentication-mutations-post-login-signs-in-with-a-username"],
  [
    "POST /two-factor",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-signs-in-with-the-token",
  ],
  [
    "POST /two-factor/resend_authentication_token",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-resends-the-token",
  ],
  [
    "POST /two-factor/switch_to_email",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-switches-to-email",
  ],
  [
    "POST /two-factor/switch_to_recovery",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-switches-to-a-recovery-code",
  ],
  [
    "POST /two-factor/switch_to_authenticator",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-switches-to-the-authenticator",
  ],
  [
    "/two-factor/verify",
    "requests/auth_mutations_parity_spec/authentication-mutations-two-factor-authentication-verifies-a-token-from-the-emailed-link",
  ],
  [
    "POST /users/forgot_password",
    "requests/auth_account_parity_spec/account-authentication-endpoints-post-users-forgot-password-sends-the-reset-instructions",
  ],
  [
    "PUT /settings",
    "requests/settings_main_signed_in_spec/settings-main-when-signed-in-update-saves-the-switches-the-locale-the-time-zone-and-the-currency",
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
    "seller:/landing/products",
    "requests/users_controller_parity_spec/userscontroller-get-landing-embed-and-landing-products-answers-an-empty-not-found-to-the-products-slice-on-the-seller-s-3e999c56",
  ],
  [
    "/:username/landing/products",
    "requests/users_controller_parity_spec/userscontroller-get-landing-embed-and-landing-products-answers-an-empty-not-found-to-the-products-slice-of-a-seller-with-4a3d1c1b",
  ],
  [
    "/products/search",
    "requests/links_controller_parity_spec/links-controller-guards-the-products-search-answers-an-empty-page-when-no-section-is-named",
  ],
  [
    "/charge_data",
    "requests/public_data_parity_spec/public-lookup-data-get-charge-data-reports-failure-for-an-address-with-no-purchases",
  ],
  [
    "/license_key_lookup_data",
    "requests/public_data_parity_spec/public-lookup-data-get-license-key-lookup-data-reports-failure-for-an-address-with-no-purchases",
  ],
  [
    "/paypal_charge_data",
    "requests/public_data_parity_spec/public-lookup-data-get-paypal-charge-data-reports-failure-for-an-unknown-invoice",
  ],
  [
    "/offer_codes/compute_discount",
    "requests/offer_codes_compute_discount_parity_spec/offer-codes-compute-discount-rejects-an-unknown-code-as-invalid-offer",
  ],
  [
    "seller:/.well-known/acme-challenge/:token",
    "requests/public_files_parity_spec/public-files-get-well-known-acme-challenge-token-serves-the-staged-challenge-on-a-seller-custom-domain",
  ],
  [
    "POST /purchases/:id/resend_receipt",
    "requests/purchases_controller_parity_spec/purchases-controller-guards-resending-a-receipt-answers-404-for-a-purchase-that-does-not-exist",
  ],
  [
    "POST /communities/:community_id/chat_messages",
    "requests/communities_mutations_signed_in_spec/communities-mutations-when-signed-in-chat-messages-posts-a-message-as-the-seller",
  ],
  [
    "POST seller:/posts/:post_id/comments",
    "requests/comments_mutations_signed_in_spec/post-comments-mutations-when-signed-in-post-posts-post-id-comments-adds-a-root-comment-of-the-seller",
  ],
  [
    "PUT seller:/posts/:post_id/comments/:id",
    "requests/comments_mutations_signed_in_spec/post-comments-mutations-when-signed-in-put-posts-post-id-comments-id-lets-the-author-edit-their-comment",
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
