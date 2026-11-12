import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRailsCookieSecrets, readEncryptedCookie } from "@/server/auth/rails-cookies";
import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/login_passkeys_parity_spec.rb: POST /login/passkey/options and POST /login/passkey. An assertion is a function of
// the challenge in the recorded session and the stored key, so each fixture's last request is a recorded valid (or tampered) assertion
// sent to Node with that session. The challenge is random: the replay checks it against the session cookie Node sets.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["login_passkeys_parity_spec"];
const ROUTE_FLAGS = "nextjs_login_passkeys";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const CHALLENGE_KEY = "webauthn_authentication_challenge";
const WARDEN_KEY = "warden.user.user.key";
const EPOCH = new Date(0);

// The session the response set: the compare ignores the (encrypted) session cookie, so this reads it.
function sessionOf(secretKeyBase: string, cookie: string, response: { cookies?: Record<string, unknown> }) {
  const raw = (response.cookies?.[cookie] as { value?: string } | undefined)?.value;
  return readEncryptedCookie(deriveRailsCookieSecrets(secretKeyBase), cookie, raw, EPOCH) as Record<
    string,
    unknown
  > | null;
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    // The seed is stamped with the replay's clock, so the epoch seconds of an introspection differ from the recording's; the
    // arithmetic is pinned by src/server/controllers/oauth-tokens.test.ts.
    // PaperTrail is off in the Rails test environment; Node writes the version row of every user update.
    "db.versions",
    "response.json.options.challenge",
    "response.cookies.XSRF-TOKEN.value",
    "response.cookies.remember_user_token.value",
    // Counted from the clock, down to the second the row was created in.
    "response.json.expires_in",
    "db.oauth_access_tokens.inserted.*.token",
    "db.oauth_access_tokens.inserted.*.refresh_token",
    "http",
  ],
};

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

describe.skipIf(!url)("Passkey login", () => {
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
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
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
    ) => {
      const rewritten = reencryptCookies(request, loaded, SECRET_KEY_BASE, now);
      return {
        ...rewritten,
        headers: { ...rewritten.headers, "x-forwarded-for": rewritten.remoteIp ?? "127.0.0.1" },
      } as never;
    },
    compare: COMPARE,
  });

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
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
        if (/-hands-/u.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions());
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, replayOptions());
        assertParity(result);
        const actual = result.exchanges[0]!.actual;
        const cookie = fixture.sessionCookie!;
        const session = sessionOf(SECRET_KEY_BASE, cookie, actual.response);
        const body = (actual.response.json ?? {}) as Record<string, unknown>;

        if (/-post-login-passkey-options-/u.test(name)) {
          // The challenge is 32 random bytes, unpadded base64url, and it is the one kept in the session.
          const challenge = (body.options as { challenge: string }).challenge;
          expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
          expect(session?.[CHALLENGE_KEY]).toBe(challenge);
        } else {
          // The challenge is spent whether or not the assertion verified, and only a verified one signs in.
          expect(session).not.toHaveProperty(CHALLENGE_KEY);
          if (body.success !== true) expect(session).not.toHaveProperty(WARDEN_KEY);
          else expect(session?.[WARDEN_KEY]).toBeDefined();
          if (
            body.success === true &&
            process.env.WRITE_NODE_PASSKEY_SESSION &&
            /signs-the-user-in-with-a-valid/u.test(name)
          ) {
            const cookies = actual.response.cookies as Record<string, { value: string }>;
            const user = await client.user.findFirstOrThrow();
            writeFileSync(
              process.env.WRITE_NODE_PASSKEY_SESSION,
              `${JSON.stringify(
                {
                  session_cookie: { name: cookie, value: cookies[cookie]!.value },
                  remember_cookie: { name: "remember_user_token", value: cookies.remember_user_token!.value },
                  user: {
                    id: Number(user.id),
                    email: user.email,
                    encrypted_password: user.encrypted_password,
                    remember_created_at: user.remember_created_at?.toISOString(),
                  },
                  issued_at: new Date().toISOString(),
                },
                null,
                2,
              )}\n`,
            );
          }
        }
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
