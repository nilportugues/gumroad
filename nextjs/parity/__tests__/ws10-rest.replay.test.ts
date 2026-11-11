import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import type { JobsChannel, RawJob } from "../src/channels";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the WS-10 specs that finish the controllers still in Rails (the Devise resend form, the integrations, the throttled routes): the
// last exchange of each fixture is sent to `next dev` with their flags on; a stand-in Rails receives whatever Node hands back.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const rackAttackHost = process.env.PARITY_RACK_ATTACK_REDIS_HOST ?? redisHost;
const DIRS = [
  "confirmations_create_parity_spec",
  "custom_domain_verifications_parity_spec",
  "rack_attack_throttles_parity_spec",
].map((spec) => path.join("parity/fixtures/requests", spec));
const ROUTE_FLAGS = [
  "nextjs_auth_confirmations",
  "nextjs_custom_domain_verify",
  "nextjs_auth_passwords",
  "nextjs_purchases_public_guards",
  "nextjs_auth_two_factor_writes",
  "nextjs_users_profile_routes",
].join(",");
const RACK_SEQUENCE = "rack-attack-throttles-";
// Rack::Attack counts per window of 20, 60 and 64 seconds; a sequence starts where none of them is about to turn over.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function alignToWindow(): Promise<void> {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now % 20 < 12 && now % 60 < 45 && now % 64 < 50) return;
    await sleep(500);
  }
}
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "http",
  ],
};

// The recorded request carries no scheme, so a Location Rails built over HTTPS (the examples that need the secure cookie) replays as HTTP.
const HTTPS_LOCATION = "mobile-pre-authorization-get-oauth-mobile-pre-authorization-new-";

const MAIL_WRAPPER = "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper";

function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {
      /* the seeder flushes the database */
    },
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data === null) continue;
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as RawJob;
        jobs.push({ class: item.class, args: item.args, queue: item.queue });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as RawJob;
          jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      return jobs;
    },
  };
}

const cases = DIRS.filter((dir) => existsSync(dir)).flatMap((dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${path.basename(dir)}/${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    ),
);

describe.skipIf(!url)("WS-10 remaining ports", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let rackRedis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    const [rackAddress = "", rackDb = "0"] = rackAttackHost.split("/");
    const [rackHostName = "127.0.0.1", rackPort = "6379"] = rackAddress.split(":");
    rackRedis = new Redis({ host: rackHostName, port: Number(rackPort), db: Number(rackDb) });
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
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: rackAttackHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DEVISE_SECRET_KEY") ? { DEVISE_SECRET_KEY: testEnv("DEVISE_SECRET_KEY")! } : {}),
      ...(testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION")
        ? { SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION")! }
        : {}),
      ...(testEnv("SECURE_EXTERNAL_ID__KEYS__1")
        ? { SECURE_EXTERNAL_ID__KEYS__1: testEnv("SECURE_EXTERNAL_ID__KEYS__1")! }
        : {}),
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = () => ({
    sql,
    redis: {
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: COMPARE,
  });

  const optionsFor = (name: string) => {
    const options = replayOptions();
    return path.basename(name).startsWith(HTTPS_LOCATION)
      ? { ...options, compare: { ignore: [...COMPARE.ignore, "response.location"] } }
      : options;
  };

  afterAll(async () => {
    await server.stop();
    rails.close();
    await closeAllRedis();
    await redis.quit();
    await rackRedis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases.slice(0, 2))
        await replayFixtureExchange(file, index, replayOptions()).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Whatever Node cannot prove goes to Rails whole, before its first write.
        if (path.basename(name).includes("-hands-")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, optionsFor(name));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        if (path.basename(name).startsWith(RACK_SEQUENCE)) {
          // Every request of the example in order: the counters live in Redis between them, and the one over the limit answers 429.
          // The first request to a route compiles it, which can outlast a window: warm up, then start the sequence on a fresh one.
          const warmUp = fixture.exchanges.findIndex((exchange) => !exchange.request.path.startsWith("/help"));
          await replayFixtureExchange(fixture, warmUp, replayOptions()).catch(() => undefined);
          await alignToWindow();
          await rackRedis.flushdb();
          const sequenceIgnore = [
            ...COMPARE.ignore,
            "response.headers.retry-after",
            // A reset mail's token is random and stamped with the clock of the replay; the mail job is not in the fixture (test adapter).
            "db.users.updated.*.changes.reset_password_token",
            "db.users.updated.*.changes.reset_password_sent_at",
            "db.users.updated.*.changes.updated_at",
          ];
          const first = fixture.exchanges.findIndex((exchange) => !exchange.request.path.startsWith("/help"));
          let throttled = 0;
          for (let at = first; at < fixture.exchanges.length; at += 1) {
            // Rails answers a missing record with its debug page in the test environment; Node answers the production body.
            const notFound = fixture.exchanges[at]!.response.status === 404;
            const options = {
              ...replayOptions(),
              compare: {
                ignore: [
                  ...sequenceIgnore,
                  ...(notFound ? ["response.body", "response.json", "response.headers.content-type"] : []),
                ],
              },
            };
            const replayed = await replayFixtureExchange(fixture, at, options);
            assertParity(replayed);
            const { expected, actual } = replayed.exchanges[0]!;
            if (expected.response.status === 429) {
              throttled += 1;
              const wait = Number(actual.response.headers["retry-after"]);
              expect(wait).toBeGreaterThanOrEqual(1);
              expect(wait).toBeLessThanOrEqual(64);
              expect(actual.response.body).toBe("Retry later\n");
            } else expect(actual.response.status).not.toBe(429);
          }
          expect(throttled).toBe(path.basename(name).includes("does-not-count") ? 0 : 1);
          return;
        }
        const replayed = await replayFixtureExchange(fixture, index, optionsFor(name));
        assertParity(replayed);
        // The session cookie's value is skipped by the comparison, so the flash it carries is read back from both sides.
        const sessionName = fixture.sessionCookie!;
        const flashOf = (cookies: Record<string, { value?: unknown }> | undefined) => {
          const raw = cookies?.[sessionName]?.value;
          if (raw === undefined) return undefined;
          const session = readEncryptedCookie(
            railsCookieSecrets(),
            sessionName,
            decodeURIComponent(String(raw)),
          ) as Record<string, unknown>;
          return JSON.stringify(session.flash ?? null);
        };
        const { expected, actual } = replayed.exchanges[0]!;
        expect(flashOf(actual.response.cookies)).toBe(flashOf(expected.response.cookies));
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
