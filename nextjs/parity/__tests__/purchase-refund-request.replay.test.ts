import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { jobKey, redisJobsChannel } from "../src/active-job";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/purchase_refund_request_page_parity_spec.rb (GET) and purchase_refund_request_create_parity_spec.rb (POST),
// Purchases::RefundRequestsController: the last exchange of each fixture is sent to `next dev` with the route flag on. A request
// the port hands back must reach the stand-in Rails with its body, before anything is written.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["purchase_refund_request_page_parity_spec", "purchase_refund_request_create_parity_spec"];
const ROUTE_FLAGS = "nextjs_purchase_refund_requests";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
// The respond-by date and the refund window depend on the day, so the clock is pinned to the recording's (see ws75-pages.replay.test.ts).
// Every fixture of both specs was recorded on this day.
const PARITY_NOW = Date.parse("2026-11-13T18:00:00Z");
// The server's clock is the real clock plus a fixed offset. The worker's fake Date is re-anchored to that same formula before every
// example: `shouldAdvanceTime` ticks 20ms per timer fire however late the fire is, so on a loaded host it falls behind the server.
// performance is not faked, so it reads the real clock.
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const secureIdVersion = testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION");
const secureIdKey = testEnv("SECURE_EXTERNAL_ID__KEYS__1");
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // Random per response: the CSP nonce and the masked CSRF token (props and the csrf-token <meta>).
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    // Rails' versions are off in the test environment (PaperTrail.enabled = false); models/concerns/paper-trail.test.ts pins the rows Node writes.
    "db.versions",
    "http",
  ],
};

const HANDED_BACK = /hands-a-/u;
// The mail jobs Node enqueues are compared with the recording's, sorted as the other replays do.
const IGNORED_JOBS = new Set<string>();

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

describe.skipIf(!url)("Purchases::RefundRequestsController", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    client = new PrismaClient({ datasourceUrl: url });
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
    clockOffset = PARITY_NOW - realNow();
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(secureIdVersion && secureIdKey
        ? { SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: secureIdVersion, SECURE_EXTERNAL_ID__KEYS__1: secureIdKey }
        : {}),
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  // Rails' debug page for a 404 is not recorded, and its content type follows the request's Accept.
  const compareFor = (file: string) =>
    readFileSync(file, "utf8").includes("rails exception debug page")
      ? {
          ignore: [
            ...COMPARE.ignore,
            "response.cookies",
            "response.body",
            "response.json",
          ],
        }
      : COMPARE;

  const options = (file: string) => ({
    sql,
    redis: redisSeeder(redis),
    jobs: redisJobsChannel(redis, IGNORED_JOBS),
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    driftDates: false,
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: compareFor(file),
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request down a code path compiles what it imports, which would age the seeded timestamps past the replayer's tolerance.
  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases)
        await replayFixtureExchange(file, index, options(file)).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const recorded = fixture.exchanges[index]!;
        recorded.jobs = [...(recorded.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        if (HANDED_BACK.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options(file));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
            decodeURIComponent(request.path.split("?")[0]!),
          );
          if (request.body) expect(handedBack[0]!.body).toBe(request.body);
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, options(file)));
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => !line.startsWith("Next.js includes"))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
