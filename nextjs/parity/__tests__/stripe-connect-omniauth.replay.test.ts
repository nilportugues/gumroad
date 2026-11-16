import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { type CapturedHttp, loadFixture } from "../src/fixture";
import { keptHttpHeaders } from "../src/http";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays stripe_connect_omniauth_parity_spec.rb: the Stripe Connect callback of a signed-in seller, from the token exchange to the redirect.
// The stand-in serves the WebMock exchanges of the recording in order (the token, the strategy's account call, Stripe::Account.retrieve),
// refuses a call that is not the next one Rails made and compares the credential by the digest the recorder keeps. A "hands ..." example must
// reach the stand-in Rails and make no provider call: the code is single-use.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = [path.join("parity/fixtures/requests", "stripe_connect_omniauth_parity_spec")];
const ROUTE_FLAGS = "nextjs_omniauth_phases";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const CLIENT_ENV = { ...(testEnv("STRIPE_API_KEY") ? { STRIPE_API_KEY: testEnv("STRIPE_API_KEY")! } : {}) };
const SEED_AGE_MS = 2000;
const PARITY_NOW = Date.now();
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;

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

type Received = { method: string; url: string; contentType?: string; body: string; headers: Record<string, string> };

const sortedForm = (body: string | undefined): [string, string][] =>
  [...new URLSearchParams(body ?? "")].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe.skipIf(!url)("Stripe Connect OmniAuth", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  let recorded: CapturedHttp[] = [];
  const received: Received[] = [];
  const mismatches: string[] = [];
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
      request.resume();
      request.on("end", () => {
        handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const call: Received = {
          method: request.method ?? "",
          url: String(request.headers["x-parity-original-url"] ?? request.url),
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
          headers: request.headers as Record<string, string>,
        };
        received.push(call);
        const expected = recorded[received.length - 1];
        const matches =
          expected !== undefined &&
          expected.method === call.method &&
          // WebMock drops the empty query a bodiless GET leaves behind.
          expected.url === call.url.replace(/\?$/u, "") &&
          (expected.contentType ?? undefined) === (call.contentType ?? undefined) &&
          JSON.stringify(sortedForm(expected.body)) === JSON.stringify(sortedForm(call.body)) &&
          (expected.headers?.authorization === undefined ||
            expected.headers.authorization === keptHttpHeaders(call.headers).authorization);
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
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    clockOffset = Math.round(PARITY_NOW - realNow());
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
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
      ...CLIENT_ENV,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
    });
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
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
    driftDates: false,
    get seedClock() {
      return new Date(Date.now() - SEED_AGE_MS);
    },
    compare: COMPARE,
  });

  const sessionOf = (name: string, cookies: Record<string, { value?: unknown }> | undefined) => {
    const raw = cookies?.[name]?.value;
    if (raw === undefined) return undefined;
    const session = readEncryptedCookie(railsCookieSecrets(), name, decodeURIComponent(String(raw))) as Record<
      string,
      unknown
    >;
    // Minted per session.
    delete session.session_id;
    delete session._csrf_token;
    delete session.two_factor_auth_token_sent_at;
    const warden = session["warden.user.user.session"] as Record<string, unknown> | undefined;
    if (warden) delete warden.last_sign_in_at;
    return session;
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
          if (mismatches.length > 0) throw new Error(`provider calls differ: ${JSON.stringify(mismatches)}`);
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
        if (mismatches.length > 0) throw new Error(`provider calls differ: ${JSON.stringify(mismatches)}`);
        expect(received).toHaveLength(recorded.length);
        // The session the callback leaves behind: the flash, the spent OmniAuth keys and the Stripe Connect data.
        const { expected, actual } = replayed.exchanges[0]!;
        const sessionName = fixture.sessionCookie!;
        const nodeSession = JSON.stringify(sessionOf(sessionName, actual.response.cookies));
        const railsSession = JSON.stringify(sessionOf(sessionName, expected.response.cookies));
        if (nodeSession !== railsSession) throw new Error(`session ${nodeSession}, Rails left ${railsSession}`);
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
