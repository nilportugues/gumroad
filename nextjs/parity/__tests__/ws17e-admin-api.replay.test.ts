import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
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
  ? readdirSync(REQUEST_ROOT).filter((dir) => /^admin_.*_parity_spec$/.test(dir))
  : [];
// The controller specs stub GUMROAD_ADMIN_ID to a fresh user's id, which a replayed server cannot reproduce: the request spec covers the legacy token.
const LEGACY_TOKEN_CASE = /legacy|configured-bearer-token|rotation-point/;
// Examples that change the world from inside the request (a stubbed lookup that approves the record after it was loaded): only Ruby can replay them.
const MID_REQUEST_RACE_CASE = /after-the-request-loaded|loaded-it|after-request-loads|approved-af-e5f0bf0d/;
const ROUTE_FLAGS = [
  "nextjs_admin_api_auth",
  "nextjs_admin_api_users",
  "nextjs_admin_api_purchases",
  "nextjs_admin_api_products",
  "nextjs_admin_api_misc",
  "nextjs_admin_api_piracy",
  "nextjs_admin_api_campaigns",
];
// Requests the port leaves to Rails: "hands a ..." in a request spec, and the controller examples named here (a state in a compliance
// address, a new watch). The replay asserts they reach the stand-in Rails untouched and write nothing.
const HANDS_BACK_CASE = /hands-a-|post-watch-(?:creates-a-watched-user-record|user-id-lookup-looks-up|user-id-lookup-prefers)|get-compliance-info-returns-(?:business-kyc-fields|submitted-kyc-fields|the-latest-alive|the-trailing-characters)/;
const API_HOST = "api.test.gumroad.com:31337";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
// The compliance info read decrypts the tax ids it shows the last four characters of.
const strongboxKey = /^STRONGBOX_GENERAL="(.+)"$/m.exec(envTest)?.[1]?.replaceAll("\\n", "\n");
const strongboxPassword = /^STRONGBOX_GENERAL_PASSWORD="?([^"\n]+)"?$/m.exec(envTest)?.[1];

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
];
// The cursor is `urlsafe(base64(json_string)--hmac)`.
function cursorInstant(fixturePath: string, index: number, ageMinutes: number): number {
  const request = loadFixture(fixturePath).exchanges[index]!.request;
  const cursor = new URLSearchParams(request.query ?? "").get("cursor")!;
  const [encoded] = Buffer.from(cursor, "base64url").toString("utf8").split("--");
  const payload = JSON.parse(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as string) as { created_at: string };
  return Date.parse(payload.created_at) + ageMinutes * 60_000;
}
// emails_sent_at is JSON text inside json_data, which the replay's date drift does not rewrite: users-reads.test.ts covers the field.
const EMAIL_REMINDER_CASE = /most-recent-email-reminder-timestamp/;

// Only the exchanges of routes routes.json sends to Node are replayed; the rest stay with Rails.
const SERVED_ROUTES = Object.keys(JSON.parse(readFileSync("routes.json", "utf8")) as Record<string, unknown>)
  .filter((key) => /^((GET|POST|PUT|PATCH|DELETE) )?api:\/internal\/admin\//.test(key))
  .map((key) => {
    const [method, route] = (/^[A-Z]+ /.test(key) ? [key.split(" ")[0]!, key.split(" ")[1]!] : ["GET", key]) as [
      string,
      string,
    ];
    return { method, regexp: new RegExp(`^${route.replace(/^api:/, "").replace(/:[a-z_]+/g, "[^/.?]+")}$`) };
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
          !EMAIL_REMINDER_CASE.test(file),
      )
      .flatMap((file) => {
        const fixturePath = path.join(root, dir, file);
        return loadFixture(fixturePath).exchanges.flatMap((exchange, index) =>
          !served(exchange.request.method, exchange.request.path)
            ? []
            : [
                [
                  `${dir.replace(/_spec$/, "")}: ${file.replace(/\.json$/, "")} #${index + 1}`,
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
const WEB_SERVED = /^\/admin\/(impersonate|unimpersonate|redirect_to_stripe_dashboard)$/;
const webCases = WEB_DIRS.flatMap((dir) =>
  readdirSync(path.join(WEB_ROOT, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixturePath = path.join(WEB_ROOT, dir, file);
      return [
        `${dir.replace(/_spec$/, "")}: ${file.replace(/\.json$/, "")}`,
        fixturePath,
        loadFixture(fixturePath).exchanges.length - 1,
      ] as const;
    })
    .filter(([, fixturePath, index]) => WEB_SERVED.test(loadFixture(fixturePath).exchanges[index]!.request.path)),
);
const cases = [...casesIn(CONTROLLER_ROOT, CONTROLLER_DIRS, false), ...casesIn(REQUEST_ROOT, REQUEST_DIRS, true)];
const SERVER_SECRET = loadFixture(cases[0]![1]).secretKeyBase;

describe.skipIf(!url)("WS-17e internal admin API parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        handedBack.push({ method: request.method ?? "", url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: [...ROUTE_FLAGS, "nextjs_admin_impersonate"].join(","),
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      // Cursors are signed with the recording app's secret_key_base, which every fixture of one checkout carries.
      SECRET_KEY_BASE: SERVER_SECRET ?? "",
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
      ...(strongboxKey && strongboxPassword ? { STRONGBOX_GENERAL: strongboxKey, STRONGBOX_GENERAL_PASSWORD: strongboxPassword } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

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
    async (_name, fixturePath, index, fromRequestSpec) => {
      if (HANDS_BACK_CASE.test(_name)) {
        handedBack.length = 0;
        const handed = await replayFixtureExchange(fixturePath, index, {
          sql,
          redis: redisSeeder(redis),
          transport: httpTransport(server.baseUrl),
          interceptHttp: false,
          jobs: redisJobs(redis),
          rewriteRequest: (request) => ({ ...request, headers: withApiHost(request.headers) }),
        });
        const request = loadFixture(fixturePath).exchanges[index]!.request;
        expect(handedBack).toHaveLength(1);
        expect(handedBack[0]).toMatchObject({ method: request.method });
        expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(decodeURIComponent(request.path.split("?")[0]!));
        // The token's last_used_at is stamped before the action runs; Rails stamps it again.
        expect(Object.keys(handed.exchanges[0]!.actual.db ?? {}).filter((table) => table !== "admin_api_tokens")).toEqual([]);
        return;
      }
      const pageAge = CURSOR_PAGES.find(([pattern]) => pattern.test(_name))?.[1];
      const pinned = pageAge !== undefined;
      if (pageAge !== undefined) vi.useFakeTimers({ now: cursorInstant(fixturePath, index, pageAge), toFake: ["Date"], shouldAdvanceTime: true });
      const result = await replayFixtureExchange(fixturePath, index, {
        ...(pinned ? { driftDates: false } : {}),
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        jobs: redisJobs(redis),
        rewriteRequest: (request) => ({ ...request, headers: withApiHost(request.headers) }),
        compare: {
          ignore: [
            ...COMPARE.ignore,
            ...(fromRequestSpec ? ["response.cookies._gumroad_app_session_test.value"] : ["response.cookies"]),
            // The server stamps the token with its own, unpinned clock.
            ...(pinned ? ["db.admin_api_tokens.updated.*.changes.last_used_at"] : []),
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
          .filter((line) => !/built-in version of this loader|^\s*$/.test(line))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
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
          .filter((line) => !/built-in version of this loader|^\s*$/.test(line))
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
