import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type CapturedHttp } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays seller_plan_checkout_parity_spec.rb: the last exchange of
// each fixture is sent to `next dev`, and a stand-in server answers the provider calls the recording saw, in order. After the replay the
// calls Node made must be the ones Rails made: method, URL, content type and body, in the same order. A "hands ..." example must make no
// provider call and reach the stand-in Rails whole.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = [path.join("parity/fixtures/requests", "seller_plan_checkout_parity_spec")];
const ROUTE_FLAGS = "nextjs_seller_plan";
// What the recording ran with (the test environment has none of these).
const CLIENT_ENV = { SELLER_PLAN_PRICE_5: "price_five_c27c", STRIPE_API_KEY: "sk_test_parity_replay_placeholder" };
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

describe.skipIf(!url)("Seller plan checkout", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  const recorded: CapturedHttp[] = [];
  const received: { method: string; url: string; body: string }[] = [];
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      request.on("end", () => response.writeHead(204).end());
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: String(request.headers["x-parity-original-url"] ?? request.url),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const answer = recorded.shift()?.response;
        if (answer === undefined) return void response.writeHead(599).end("parity: no recorded answer left");
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      OUTBOUND_HTTP_STAND_IN: `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...CLIENT_ENV,
      ...(testEnv("GOOGLE_CLIENT_ID") ? { GOOGLE_CLIENT_ID: testEnv("GOOGLE_CLIENT_ID")! } : {}),
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
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: COMPARE,
  });

  afterAll(async () => {
    await server.stop();
    rails.close();
    await new Promise((resolve) => standIn.close(resolve));
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases.slice(0, 1))
        await replayFixtureExchange(file, index, replayOptions()).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        recorded.splice(0, recorded.length, ...fixture.exchanges[index]!.http);
        received.length = 0;
        handedBack.length = 0;
        const replayed = await replayFixtureExchange(fixture, index, replayOptions());
        if (path.basename(name).includes("-hands-")) {
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toEqual({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(received).toEqual([]);
          expect(Object.keys(replayed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        assertParity(replayed);
        // The session cookie's value is skipped by the comparison, so the flash it carries is read back from both sides.
        const flashOf = (cookies: Record<string, { value?: unknown }> | undefined) => {
          const raw = cookies?.[fixture.sessionCookie!]?.value;
          if (raw === undefined) return undefined;
          const session = readEncryptedCookie(
            railsCookieSecrets(),
            fixture.sessionCookie!,
            decodeURIComponent(String(raw)),
          ) as Record<string, unknown>;
          return JSON.stringify(session.flash ?? null);
        };
        const { expected, actual } = replayed.exchanges[0]!;
        expect(flashOf(actual.response.cookies)).toBe(flashOf(expected.response.cookies));
        // The port made the provider calls Rails made: the same method, URL and body, in the same order.
        // Net::HTTP sends the bare `?` of an empty query (the Stripe client mirrors it); WebMock records the URL without it.
        expect(
          received.map(({ method, url: original, body }) => ({ method, url: original.replace(/\?$/u, ""), body })),
        ).toEqual(
          fixture.exchanges[index]!.http.map((call) => ({ method: call.method, url: call.url, body: call.body ?? "" })),
        );
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
