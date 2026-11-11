import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { resolveTimeToken } from "../src/canonical";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { type CapturedHttp, loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays social_connect_token_exchange_parity_spec.rb: the callbacks of YouTube, Instagram and TikTok that carry a code. The provider
// answers come from a stand-in server (OUTBOUND_HTTP_STAND_IN) that serves the WebMock exchanges of the recording in order, refuses a call
// that is not the next one Rails made, and keeps what Node sent. After the replay the test checks that every recorded call was made and
// none else, with the credentials a provider would check: Basic for Google's token request, the client id and secret in the form of the other
// two, the bearer token of the exchange on every later call. A "hands ..." example must make no provider call and reach the stand-in Rails.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = [path.join("parity/fixtures/requests", "social_connect_token_exchange_parity_spec")];
const ROUTE_FLAGS = "nextjs_omniauth_phases";
// What the recording ran with (the test environment has none of these).
const CLIENT_ENV = {
  INSTAGRAM_APP_ID: "instagram-app-id",
  INSTAGRAM_APP_SECRET: "instagram-app-secret",
  TIKTOK_CLIENT_KEY: "tiktok-client-key",
  TIKTOK_CLIENT_SECRET: "tiktok-client-secret",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const TOKEN_ENDPOINT =
  /^https:\/\/(?:oauth2\.googleapis\.com\/token|api\.instagram\.com\/oauth\/access_token|open\.tiktokapis\.com\/v2\/oauth\/token\/)$/u;
const TIME_TOKEN = /<now(?:[+-]\d+[smh])?>/gu;

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

// WebMock normalises a recorded URL (sorted query, decoded); both sides are brought to that form.
function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  const pairs = [...parsed.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${parsed.origin}${parsed.pathname}?${pairs.map(([key, v]) => `${key}=${v}`).join("&")}`;
}

function normalizedForm(body: string | undefined): [string, string][] {
  return [...new URLSearchParams(body ?? "")].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const resolveTimes = (body: string, now: Date) =>
  body.replace(
    TIME_TOKEN,
    (token) =>
      resolveTimeToken(token, now)
        ?.toISOString()
        .replace(/\.\d{3}Z$/u, "Z") ?? token,
  );

type Received = { method: string; url: string; contentType?: string; body: string; authorization?: string };

describe.skipIf(!url)("Social connect token exchange", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  let recorded: CapturedHttp[] = [];
  const received: Received[] = [];
  const mismatches: string[] = [];
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.SECRET_KEY_BASE = SECRET_KEY_BASE;
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
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const original = String(request.headers["x-parity-original-url"] ?? request.url);
        const call: Received = {
          method: request.method ?? "",
          url: original,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
          authorization: request.headers.authorization,
        };
        received.push(call);
        const expected = recorded[received.length - 1];
        const matches =
          expected !== undefined &&
          expected.method === call.method &&
          normalizedUrl(expected.url) === normalizedUrl(call.url) &&
          (expected.contentType ?? undefined) === (call.contentType ?? undefined) &&
          JSON.stringify(normalizedForm(expected.body)) === JSON.stringify(normalizedForm(call.body));
        if (!matches) {
          mismatches.push(
            `call ${received.length}: sent ${call.method} ${call.url} ${call.body}, Rails made ${
              expected ? `${expected.method} ${expected.url} ${expected.body ?? ""}` : "no call"
            }`,
          );
          return void response.writeHead(599).end("parity: not the next recorded call");
        }
        const answer = expected.response;
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(resolveTimes(answer.body ?? "", new Date()));
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      OUTBOUND_HTTP_STAND_IN: `http://127.0.0.1:${(standIn.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      ...(testEnv("GOOGLE_CLIENT_ID") ? { GOOGLE_CLIENT_ID: testEnv("GOOGLE_CLIENT_ID")! } : {}),
      ...CLIENT_ENV,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    rails.close();
    await new Promise((resolve) => standIn.close(resolve));
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

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

  const sessionOf = (name: string, cookies: Record<string, { value?: unknown }> | undefined) => {
    const raw = cookies?.[name]?.value;
    if (raw === undefined) return undefined;
    return readEncryptedCookie(railsCookieSecrets(), name, decodeURIComponent(String(raw))) as Record<string, unknown>;
  };

  // The credentials Rails' gems send, which the recording keeps no headers of.
  const expectCredentials = (calls: Received[], recordedCalls: CapturedHttp[]) => {
    const exchangeAt = recordedCalls.findIndex((call) => TOKEN_ENDPOINT.test(call.url));
    if (exchangeAt === -1) return;
    const body = JSON.parse(recordedCalls[exchangeAt]!.response.body ?? "{}") as {
      access_token?: string;
      data?: { access_token?: string }[];
    };
    const token = body.access_token ?? body.data?.[0]?.access_token;
    const bearer = `Bearer ${String(token)}`;
    calls.forEach((call, at) => {
      if (at === exchangeAt) {
        if (call.url.includes("googleapis")) {
          expect(call.authorization).toBe(
            `Basic ${Buffer.from(`${testEnv("GOOGLE_CLIENT_ID")}:${CLIENT_ENV.GOOGLE_CLIENT_SECRET}`).toString("base64")}`,
          );
        } else {
          expect(call.authorization).toBeUndefined();
          const form = Object.fromEntries(new URLSearchParams(call.body));
          if (call.url.includes("instagram"))
            expect(form).toMatchObject({
              client_id: CLIENT_ENV.INSTAGRAM_APP_ID,
              client_secret: CLIENT_ENV.INSTAGRAM_APP_SECRET,
            });
          else
            expect(form).toMatchObject({
              client_id: CLIENT_ENV.TIKTOK_CLIENT_KEY,
              client_key: CLIENT_ENV.TIKTOK_CLIENT_KEY,
              client_secret: CLIENT_ENV.TIKTOK_CLIENT_SECRET,
            });
        }
      } else if (call.url.includes("tokeninfo")) expect(call.authorization).toBeUndefined();
      else expect(call.authorization).toBe(bearer);
    });
  };

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
        const exchange = fixture.exchanges[index]!;
        recorded = exchange.http;
        received.length = 0;
        mismatches.length = 0;
        handedBack.length = 0;
        // Whatever Node cannot prove goes to Rails whole, before the code is spent.
        if (path.basename(name).includes("-hands-")) {
          const handed = await replayFixtureExchange(fixture, index, replayOptions());
          expect(received).toHaveLength(0);
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: exchange.request.method,
            url: exchange.request.query ? `${exchange.request.path}?${exchange.request.query}` : exchange.request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        const replayed = await replayFixtureExchange(fixture, index, replayOptions());
        assertParity(replayed);
        // The port made the provider calls Rails made, in the same order and with the same credentials, and no others.
        expect(mismatches).toEqual([]);
        expect(received).toHaveLength(recorded.length);
        expectCredentials(received, recorded);
        // The session the callback leaves behind: the flash, the spent OmniAuth keys and the return entry.
        const { expected, actual } = replayed.exchanges[0]!;
        const sessionName = fixture.sessionCookie!;
        expect(sessionOf(sessionName, actual.response.cookies)).toEqual(
          sessionOf(sessionName, expected.response.cookies),
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
