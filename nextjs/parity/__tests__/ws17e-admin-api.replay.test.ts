import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the controller specs of Api::Internal::Admin::* (spec/controllers/api/internal/admin, recorded with PARITY_RECORD=all)
// against the admin API handlers (server/controllers/internal-admin). Each request is sent to the API host with its recorded path;
// the Gumroad host's /api/ prefix reaches the same handlers (checked by the "api prefix" cases).
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/5";
// Controller specs record no Rack middleware (no session or CSRF cookies); the request specs (spec/requests/api/internal/admin_*_parity_spec.rb) do.
const CONTROLLER_ROOT = "parity/fixtures/controllers/api/internal/admin";
const REQUEST_ROOT = "parity/fixtures/requests/api/internal";
const CONTROLLER_DIRS = (process.env.WS17E_SPECS?.split(",") ?? readdirSync(CONTROLLER_ROOT)).filter((dir) =>
  existsSync(path.join(CONTROLLER_ROOT, dir)),
);
const REQUEST_DIRS = existsSync(REQUEST_ROOT)
  ? readdirSync(REQUEST_ROOT).filter(
      (dir) =>
        /^admin_.*_parity_spec$/u.test(dir) && (process.env.WS17E_REQUEST_SPECS?.split(",").includes(dir) ?? true),
    )
  : [];
// The controller specs stub GUMROAD_ADMIN_ID to a fresh user's id, which a replayed server cannot reproduce: the request spec covers the legacy token.
const LEGACY_TOKEN_CASE = /legacy|configured-bearer-token|rotation-point/u;
// Examples that change the world from inside the request (a stubbed lookup that approves the record after it was loaded): only Ruby can replay them.
const MID_REQUEST_RACE_CASE =
  /after-the-request-loaded|loaded-it|after-request-loads|approved-af-e5f0bf0d|becomes-s-b6572bdb|started-screening-after/u;
// Examples whose figures come from a Ruby stub (Stripe::Account.retrieve, User#sales_cents_total) that a recorded seed cannot carry. The
// Stripe path is covered in user-info.test.ts from the response bodies the request spec recorded.
const RUBY_STUB_CASE =
  /user-info-stripe-|get-info-computes-sales-count-and-total-earnings-formatted|get-info-surfaces-the-stripe-connect-account-id|get-info-makes-at-most-one-stripe-call|get-info-adds-the-view-stripe-account-link/u;
const USER_INFO_CASE = /get-info|user-info/u;
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const ROUTE_FLAGS = [
  "nextjs_admin_api_auth",
  "nextjs_admin_api_users",
  "nextjs_admin_api_purchases",
  "nextjs_admin_api_products",
  "nextjs_admin_api_misc",
  "nextjs_admin_api_piracy",
  "nextjs_admin_api_campaigns",
];
// Requests the port leaves to Rails: "hands a ..." in a request spec, and the controller examples named here (a new watch). The replay asserts they reach the stand-in Rails untouched and write nothing.
const HANDS_BACK_CASE =
  /hands-(?:a|an|the|warnings)-|post-watch-(?:creates-a-watched-user-record|user-id-lookup-looks-up|user-id-lookup-prefers)|post-resolve-records-the-outcome/u;
// Controller examples that run the action a port only guards (the write itself, a Stripe-charged purchase, a social or radar case the read
// does not reproduce): the port answers them with the hand-back, which the replay asserts the same way. Matched on the example's id.
const HANDED_CONTROLLER_EXAMPLES = new Set([
  "api-internal-admin-featureannouncementcampaignscontroller-the-lifecycle-previews-approves-the-previewed-copy-and-starts-88c9e87a",
  "api-internal-admin-featureannouncementcampaignscontroller-the-lifecycle-previews-the-digest-of-the-copy-it-rendered-when-eb9fe53a",
  "api-internal-admin-userscontroller-get-purchases-accepts-every-state-defined-on-the-purchase-state-machine-including-pre-f59a5026",
  "api-internal-admin-userscontroller-get-purchases-filters-by-a-created-at-window-using-iso-8601-timestamps",
  "api-internal-admin-userscontroller-get-purchases-filters-by-a-single-purchase-state",
  "api-internal-admin-userscontroller-get-purchases-filters-by-chargedback-false",
  "api-internal-admin-userscontroller-get-purchases-filters-by-chargedback-true",
  "api-internal-admin-userscontroller-get-purchases-filters-by-has-affiliate-true",
  "api-internal-admin-userscontroller-get-purchases-filters-by-has-early-fraud-warning-false",
  "api-internal-admin-userscontroller-get-purchases-filters-by-has-early-fraud-warning-true",
  "api-internal-admin-userscontroller-get-purchases-filters-by-ip-address",
  "api-internal-admin-userscontroller-get-purchases-filters-by-multiple-purchase-states-from-a-comma-separated-list",
  "api-internal-admin-userscontroller-get-purchases-filters-by-stripe-fingerprint",
  "api-internal-admin-userscontroller-get-purchases-paginates-purchases-with-a-cursor",
  "api-internal-admin-userscontroller-get-purchases-returns-purchases-matched-by-purchaser-id-and-by-email-newest-first",
  "api-internal-admin-userscontroller-get-purchases-scopes-results-to-the-requested-user",
  "api-internal-admin-userscontroller-get-purchases-serializes-each-row-with-the-shared-purchase-payload",
  "api-internal-admin-userscontroller-get-purchases-skips-the-email-branch-when-the-user-has-no-email-so-null-email-purchas-3c577e79",
  "api-internal-admin-userscontroller-get-radar-stats-returns-seller-radar-aggregates-with-cursor-paginated-recent-efws",
  "api-internal-admin-userscontroller-get-social-connections-returns-only-the-latest-dated-shadow-evidence-without-evaluati-aab9f574",
  "api-internal-admin-userscontroller-post-add-credit-claws-back-credit-with-a-negative-amount-without-emailing-the-user",
  "api-internal-admin-userscontroller-post-add-credit-creates-a-credit-with-the-reason-and-notifies-the-user",
  "api-internal-admin-userscontroller-post-add-credit-records-an-audit-log-attributed-to-the-actor",
  "api-internal-admin-userscontroller-post-add-credit-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-add-credit-user-id-lookup-prefers-user-id-over-email-when-both-are-provided",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-does-not-let-a-seller-clear-an-admin-takedown-by-unpublis-48118125",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-does-not-let-a-seller-republish-an-admin-taken-down-membe-6fa68305",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-flags-the-user-for-a-policy-violation-and-creates-user-an-ff143115",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-records-the-admin-api-audit-log-with-the-tos-flag-action-1902585c",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-returns-422-when-the-state-machine-rejects-the-flag-witho-6e67fb23",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-returns-422-when-the-state-machine-rejects-the-flag",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-still-takes-the-product-down-when-the-user-is-already-fla-e7fcf37b",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-takes-down-both-listings-when-two-reports-race-on-an-init-8c0bba25",
  "api-internal-admin-userscontroller-post-flag-for-tos-violation-unpublishes-rather-than-deletes-a-membership-so-existing-fd632c71",
  "api-internal-admin-userscontroller-post-mark-compliant-keeps-the-existing-sibling-account-compliant-side-effect",
  "api-internal-admin-userscontroller-post-mark-compliant-marks-the-user-compliant-and-creates-separate-audit-and-note-comm-02010071",
  "api-internal-admin-userscontroller-post-mark-compliant-returns-422-without-marking-the-user-compliant-when-the-note-is-i-dabfe8ee",
  "api-internal-admin-userscontroller-post-mark-compliant-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-mark-compliant-user-id-lookup-prefers-user-id-over-email-when-both-are-provided",
  "api-internal-admin-userscontroller-post-mark-compliant-when-the-user-is-suspended-lifts-the-suspension-when-clear-suspen-c07e0290",
  "api-internal-admin-userscontroller-post-mark-compliant-when-the-user-s-payouts-are-paused-by-an-admin-leaves-a-payout-pa-1f5c3099",
  "api-internal-admin-userscontroller-post-mark-compliant-when-the-user-s-payouts-are-paused-by-an-admin-leaves-the-payout-0f8100ac",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-counts-only-refundable-purchases-excludes-refunded-and-char-65d081b1",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-queues-the-bulk-refund-without-buyer-blocking-by-default",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-queues-with-buyer-blocking-when-block-buyers-is-true",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-records-the-admin-api-audit-log-with-block-buyers-in-the-pa-7402cd93",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-returns-409-when-a-bulk-refund-run-is-already-queued-unique-34b29209",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-returns-409-with-the-current-count-when-expected-purchase-c-3c8bd907",
  "api-internal-admin-userscontroller-post-refund-all-for-fraud-treats-non-true-block-buyers-values-including-no-as-false",
  "api-internal-admin-userscontroller-post-refund-balance-enqueues-a-refund-worker-when-the-expected-values-match",
  "api-internal-admin-userscontroller-post-reset-password-sends-reset-password-instructions-and-returns-success",
  "api-internal-admin-userscontroller-post-reset-password-with-a-user-lookup-helper-stubbed-user-id-lookup-looks-up-the-use-44d23780",
  "api-internal-admin-userscontroller-post-reset-password-with-a-user-lookup-helper-stubbed-user-id-lookup-prefers-user-id-7c0975af",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-restores-the-bank-rail-clears-the-paypal-address-and-re-556184db",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-returns-422-for-an-invalid-note-without-restoring-anyth-4beba2d7",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-returns-422-when-the-user-still-has-an-active-bank-acco-d68ee91e",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-returns-422-without-restoring-a-rail-a-google-or-apple-e4cc5a7e",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-returns-422-without-restoring-a-rail-from-a-different-c-9fa7d6bc",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-restore-bank-payout-rail-user-id-lookup-prefers-user-id-over-email-when-both-are-238145ee",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-creates-an-extra-suspension-note-when-one-is-provided",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-returns-422-when-the-state-machine-rejects-the-suspension",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-returns-422-when-the-user-is-suspended-for-a-different-reason",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-returns-422-without-suspending-the-user-when-the-suspension-no-4b926e43",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-suspends-the-user-for-fraud-and-creates-an-audit-comment-attri-0f3d6dd6",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-suspend-for-fraud-user-id-lookup-prefers-user-id-over-email-when-both-are-provid-3c2966ca",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-creates-an-extra-suspension-note-when-one-is-provided",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-records-the-admin-api-audit-log-with-the-tos-suspensio-90133ff4",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-returns-422-when-the-state-machine-rejects-the-suspens-db81cf80",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-returns-422-when-the-user-is-suspended-for-fraud",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-returns-422-without-suspending-the-user-when-the-note-bf560ef6",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-suspends-the-user-for-a-policy-violation-and-creates-a-90fe7b1b",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-suspend-for-tos-violation-user-id-lookup-prefers-user-id-over-email-when-both-ar-25dc736a",
  "api-internal-admin-userscontroller-post-two-factor-authentication-disables-two-factor-authentication-and-destroys-the-to-044dd2ef",
  "api-internal-admin-userscontroller-post-two-factor-authentication-enables-two-factor-authentication",
  "api-internal-admin-userscontroller-post-two-factor-authentication-treats-ruby-false-as-a-valid-disable-request",
  "api-internal-admin-userscontroller-post-two-factor-authentication-user-id-lookup-looks-up-the-user-by-user-id",
  "api-internal-admin-userscontroller-post-two-factor-authentication-user-id-lookup-prefers-user-id-over-email-when-both-ar-1bd867cc",
  "api-internal-admin-userscontroller-post-update-email-accepts-expected-email-when-it-matches-the-target-user",
  "api-internal-admin-userscontroller-post-update-email-returns-422-when-the-new-email-collides-with-an-existing-user",
  "api-internal-admin-userscontroller-post-update-email-updates-the-email-and-returns-the-pending-confirmation-state",
  "api-internal-admin-userscontroller-post-update-email-uses-user-id-as-the-lookup-key-when-current-email-is-also-provided",
  "api-internal-admin-userscontroller-get-purchases-serializes-nil-seller-fields-when-a-purchase-has-no-seller",
  "internal-admin-api-payout-reads-and-the-writes-that-stay-in-front-of-rails-get-feature-announcement-campaigns-id-preview-f22f1257",
]);
const handsBack = (name: string) =>
  HANDS_BACK_CASE.test(name) || HANDED_CONTROLLER_EXAMPLES.has(name.replace(/^[a-z_]+: /u, "").replace(/ #\d+$/u, ""));
const API_HOST = "api.test.gumroad.com:31337";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
// The compliance info read decrypts the tax ids it shows the last four characters of.
const strongboxKey = /^STRONGBOX_GENERAL="(.+)"$/mu.exec(envTest)?.[1]?.replaceAll("\\n", "\n");
const strongboxPassword = /^STRONGBOX_GENERAL_PASSWORD="?([^"\n]+)"?$/mu.exec(envTest)?.[1];

// Random per request: the plaintext token and its external id, the audit row's request id.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.cookies.__profilin",
    "db.versions",
    "response.cookies.XSRF-TOKEN.value",
    "response.json.token",
    "response.json.token_external_id",
    "db.admin_api_tokens.inserted.*.external_id",
    "db.admin_api_tokens.inserted.*.token_hash",
    "db.admin_api_audit_logs.inserted.*.request_id",
    // A new piracy report gets a random external id.
    "db.piracy_reports.inserted.*.external_id",
    "response.json.report.report_id",
    // A new sales hold gets a random external id.
    "db.product_sales_holds.inserted.*.external_id",
    "response.json.sales_hold.id",
    "response.json.product.active_sales_hold_id",
    // A cursor holds the time of the row it follows, which the replay seeds relative to its own clock.
    "response.json.pagination.next",
  ],
};

// A controller spec that sets the Authorization header to nil is recorded with an empty one.
const withApiHost = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...headers, host: API_HOST }).filter(([name, value]) => name !== "authorization" || value !== ""),
  );

type SidekiqItem = { class: string; args: unknown[]; queue: string };

function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {},
    async drain(): Promise<RawJob[]> {
      const items: SidekiqItem[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data !== null) items.push(JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as SidekiqItem);
      }
      for (const key of await redis.keys("queue:*"))
        for (const raw of await redis.lrange(key, 0, -1)) items.push(JSON.parse(raw) as SidekiqItem);
      return items.map((item) => ({ class: item.class, args: item.args, queue: item.queue }));
    },
  };
}

// A cursor is signed and holds the created_at of the row it follows, so the clock has to stand where it stood when the rows were made:
// that row's age in minutes after its created_at. Date is pinned to that instant for the examples listed.
const CURSOR_PAGES: [RegExp, number][] = [
  [/paginates-comments-with-a-cursor #2/u, 120],
  [/paginates-affiliates-with-a-cursor #2/u, 120],
  [/applies-a-granted-cursor-to-the-received-scope.* #2/u, 4320],
  [/pages-the-affiliates-with-a-signed-cursor #2/u, 120],
  [/pages-the-purchases-that-share-an-ip-address-with-a-signed-cursor #2/u, 60],
  [/get-purchases-paginates-purchases-with-a-cursor #2/u, 120],
];
// The cursor is `urlsafe(base64(json_string)--hmac)`.
function cursorInstant(fixturePath: string, index: number, ageMinutes: number): number {
  const request = loadFixture(fixturePath).exchanges[index]!.request;
  const cursor = new URLSearchParams(request.query ?? "").get("cursor")!;
  const [encoded] = Buffer.from(cursor, "base64url").toString("utf8").split("--");
  const payload = JSON.parse(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as string) as {
    created_at: string;
  };
  return Date.parse(payload.created_at) + ageMinutes * 60_000;
}
// emails_sent_at is JSON text inside json_data, which the replay's date drift does not rewrite: users-reads.test.ts covers the field.
// The counter-notice example sends an absolute received_on that the notice window (sent_at - 1 day to tomorrow) outgrows within days.
const EMAIL_REMINDER_CASE = /most-recent-email-reminder-timestamp|post-counter-notice-records-the-counter-notice/u;

// Only the exchanges of routes routes.json sends to Node are replayed; the rest stay with Rails.
const SERVED_ROUTES = Object.keys(JSON.parse(readFileSync("routes.json", "utf8")) as Record<string, unknown>)
  .filter((key) => /^((GET|POST|PUT|PATCH|DELETE) )?api:\/internal\/admin\//u.test(key))
  .map((key) => {
    const [method, route] = (/^[A-Z]+ /u.test(key) ? [key.split(" ")[0]!, key.split(" ")[1]!] : ["GET", key]) as [
      string,
      string,
    ];
    return { method, regexp: new RegExp(`^${route.replace(/^api:/u, "").replace(/:[a-z_]+/gu, "[^/.?]+")}$`, "u") };
  })
  .map(({ method, regexp }) => ({ method, regexp }));
const served = (method: string, requestPath: string) =>
  SERVED_ROUTES.some((route) => route.method === method && route.regexp.test(requestPath));
const casesIn = (root: string, dirs: string[], fromRequestSpec: boolean) =>
  dirs.flatMap((dir) =>
    readdirSync(path.join(root, dir))
      .filter(
        (file) =>
          file.endsWith(".json") &&
          (fromRequestSpec || !LEGACY_TOKEN_CASE.test(file)) &&
          !MID_REQUEST_RACE_CASE.test(file) &&
          !RUBY_STUB_CASE.test(file) &&
          !EMAIL_REMINDER_CASE.test(file),
      )
      .flatMap((file) => {
        const fixturePath = path.join(root, dir, file);
        return loadFixture(fixturePath).exchanges.flatMap((exchange, index) =>
          !served(exchange.request.method, exchange.request.path)
            ? []
            : [
                [
                  `${dir.replace(/_spec$/u, "")}: ${file.replace(/\.json$/u, "")} #${index + 1}`,
                  fixturePath,
                  index,
                  fromRequestSpec,
                ] as const,
              ],
        );
      }),
  );
// Admin::BaseController's web entry points: recorded after a real login, on the Gumroad host.
const WEB_ROOT = "parity/fixtures/requests";
const WEB_DIRS = ["admin_impersonate_parity_spec"].filter((dir) => existsSync(path.join(WEB_ROOT, dir)));
const WEB_SERVED = /^\/admin\/(impersonate|unimpersonate|redirect_to_stripe_dashboard|(features|sidekiq)(\/.*)?)$/u;
const allWebCases = WEB_DIRS.flatMap((dir) =>
  readdirSync(path.join(WEB_ROOT, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixturePath = path.join(WEB_ROOT, dir, file);
      return [
        `${dir.replace(/_spec$/u, "")}: ${file.replace(/\.json$/u, "")}`,
        fixturePath,
        loadFixture(fixturePath).exchanges.length - 1,
      ] as const;
    })
    .filter(([, fixturePath, index]) => WEB_SERVED.test(loadFixture(fixturePath).exchanges[index]!.request.path)),
);
// A team member reaching the Sidekiq web or Flipper UI mount is the vendor Rack app's request: the replay checks it reached Rails.
const webCases = allWebCases.filter(([name]) => !/-hands-a-/u.test(name));
const webHandedCases = allWebCases.filter(([name]) => /-hands-a-/u.test(name));
const cases = [...casesIn(CONTROLLER_ROOT, CONTROLLER_DIRS, false), ...casesIn(REQUEST_ROOT, REQUEST_DIRS, true)];
const SERVER_SECRET = loadFixture(cases[0]![1]).secretKeyBase;

describe.skipIf(!url)("WS-17e internal admin API parity", () => {
  let client: PrismaClient;
  let es: ElasticsearchClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        handedBack.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: [...ROUTE_FLAGS, "nextjs_admin_impersonate", "nextjs_admin_vendor_mounts"].join(","),
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      // Cursors are signed with the recording app's secret_key_base, which every fixture of one checkout carries.
      SECRET_KEY_BASE: SERVER_SECRET ?? "",
      DATABASE_URL: url!,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
      ...(strongboxKey && strongboxPassword
        ? { STRONGBOX_GENERAL: strongboxKey, STRONGBOX_GENERAL_PASSWORD: strongboxPassword }
        : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    await new Promise((resolve) => rails.close(resolve));
    await closeAllRedis();
    await redis.quit();
    await es.close();
    await client.$disconnect();
    process.env = saved;
  });

  // The user info sums sales from the purchases index, which the replay rebuilds from the seeded rows.
  const seeder = (name: string) =>
    USER_INFO_CASE.test(name)
      ? {
          reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
            await redisSeeder(redis).reset(entries);
            const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
            await recreateIndex(es, purchases);
            await reindexPurchases(es, purchases.name, sql);
          },
        }
      : redisSeeder(redis);

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request down a code path compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it("compiles the handlers", async () => {
    for (const [, fixturePath, index] of cases) {
      await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        jobs: redisJobs(redis),
        rewriteRequest: (request) => ({ ...request, headers: withApiHost(request.headers) }),
      }).catch(() => undefined);
    }
  }, 600_000);

  it.each(cases)(
    "%s",
    async (name, fixturePath, index, fromRequestSpec) => {
      const pageAge = CURSOR_PAGES.find(([pattern]) => pattern.test(name))?.[1];
      const pinned = pageAge !== undefined;
      if (handsBack(name)) {
        handedBack.length = 0;
        if (pageAge !== undefined)
          vi.useFakeTimers({
            now: cursorInstant(fixturePath, index, pageAge),
            toFake: ["Date"],
            shouldAdvanceTime: true,
          });
        const handed = await replayFixtureExchange(fixturePath, index, {
          ...(pinned ? { driftDates: false } : {}),
          sql,
          redis: redisSeeder(redis),
          transport: httpTransport(server.baseUrl),
          interceptHttp: false,
          jobs: redisJobs(redis),
          rewriteRequest: (request) => ({ ...request, headers: withApiHost(request.headers) }),
        }).finally(() => {
          if (pinned) vi.useRealTimers();
        });
        const request = loadFixture(fixturePath).exchanges[index]!.request;
        expect(handedBack).toHaveLength(1);
        expect(handedBack[0]).toMatchObject({ method: request.method });
        expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
          decodeURIComponent(request.path.split("?")[0]!),
        );
        // The token's last_used_at is stamped before the action runs; Rails stamps it again.
        expect(Object.keys(handed.exchanges[0]!.actual.db).filter((table) => table !== "admin_api_tokens")).toEqual([]);
        return;
      }
      if (pageAge !== undefined)
        vi.useFakeTimers({
          now: cursorInstant(fixturePath, index, pageAge),
          toFake: ["Date"],
          shouldAdvanceTime: true,
        });
      const result = await replayFixtureExchange(fixturePath, index, {
        ...(pinned ? { driftDates: false } : {}),
        sql,
        redis: seeder(name),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        jobs: redisJobs(redis),
        rewriteRequest: (request) => ({ ...request, headers: withApiHost(request.headers) }),
        compare: {
          ignore: [
            ...COMPARE.ignore,
            ...(fromRequestSpec ? ["response.cookies._gumroad_app_session_test.value"] : ["response.cookies"]),
            // The sales totals ask Elasticsearch from the server process, which the replayer cannot observe; the totals are compared in the body.
            ...(USER_INFO_CASE.test(name) ? ["http"] : []),
            // The server stamps the token with its own, unpinned clock.
            ...(pinned
              ? [
                  "db.admin_api_tokens.updated.*.changes.last_used_at",
                  // Twenty years from the pinned clock, measured against the replay's own now: the gap grows with the recording's age.
                  "response.cookies._gumroad_app_session_test.expires",
                  "response.cookies._gumroad_guid.expires",
                ]
              : []),
          ],
        },
      }).finally(() => {
        if (pinned) vi.useRealTimers();
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => !/built-in version of this loader|^\s*$/u.test(line))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(webHandedCases)(
    "%s",
    async (_name, fixturePath, index) => {
      handedBack.length = 0;
      await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SERVER_SECRET!, now),
      });
      const request = loadFixture(fixturePath).exchanges[index]!.request;
      expect(handedBack).toHaveLength(1);
      expect(handedBack[0]).toMatchObject({ method: request.method });
      expect(handedBack[0]!.url.split("?")[0]).toBe(request.path.split("?")[0]);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(webCases)(
    "%s",
    async (_name, fixturePath, index) => {
      const result = await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SERVER_SECRET!, now),
        compare: {
          ignore: [
            ...COMPARE.ignore,
            "response.cookies._gumroad_app_session_test.value",
            "response.cookies.current_seller_id.value",
            "response.body",
            "db.users.updated.*.changes.updated_at",
          ],
        },
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => !/built-in version of this loader|^\s*$/u.test(line))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it(
    "serves the /api prefix of the Gumroad host through the same handlers",
    async () => {
      const fixturePath = cases.find(
        ([name]) => name.includes("whoami") && name.includes("returns-the-authenticated"),
      )?.[1];
      if (fixturePath === undefined) return;
      const result = await replayFixtureExchange(fixturePath, 0, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request) => ({
          ...request,
          path: `/api${request.path}`,
          headers: { ...request.headers, host: "app.test.gumroad.com:31337" },
        }),
        compare: { ignore: [...COMPARE.ignore, "response.cookies"] },
      });
      assertParity(result);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
