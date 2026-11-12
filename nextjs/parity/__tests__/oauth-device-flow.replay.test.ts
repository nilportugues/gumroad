import { createHash } from "node:crypto";
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

// With WRITE_NODE_DEVICE=<file> it also writes the codes and tokens Node issued, for spec/requests/oauth_node_device_flow_spec.rb.
// Replays spec/requests/oauth_device_flow_parity_spec.rb: POST /oauth/device/code, the device-code grant of POST /oauth/token, and the
// signed-out GET and POST /oauth/device. The codes and tokens are random, so the replay checks their format and that the stored digests
// are the SHA256 of what the response carries; whatever Node hands back to Rails goes to a stand-in that must receive it before any write.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["oauth_device_flow_parity_spec"];
const ROUTE_FLAGS = "nextjs_oauth_tokens,nextjs_oauth_device";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const HANDOFFS_KEY = "oauth_device_authorization_user_code_handoffs";
const EPOCH = new Date(0);

// The session the response set, as the handoffs it holds: the compare ignores the (encrypted) session cookie, so this reads it.
function handoffsOf(secretKeyBase: string, cookie: string, response: { cookies?: Record<string, unknown> }) {
  const raw = (response.cookies?.[cookie] as { value?: string } | undefined)?.value;
  const session = readEncryptedCookie(deriveRailsCookieSecrets(secretKeyBase), cookie, raw, EPOCH) as Record<
    string,
    unknown
  > | null;
  return (session?.[HANDOFFS_KEY] ?? null) as Record<string, { user_code: string; created_at: number }> | null;
}

// The recorded handoffs carry the recording's clock; the code expires them after ten minutes, so they are moved to just before the replay.
function freshenHandoffs(session: unknown, now: Date): unknown {
  const data = session as Record<string, unknown>;
  const handoffs = data[HANDOFFS_KEY];
  if (typeof handoffs !== "object" || handoffs === null) return session;
  const created = Math.floor(now.getTime() / 1000) - 1;
  return {
    ...data,
    [HANDOFFS_KEY]: Object.fromEntries(
      Object.entries(handoffs).map(([key, entry], index) => [
        key,
        { ...(entry as object), created_at: created - index },
      ]),
    ),
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    // The seed is stamped with the replay's clock, so the epoch seconds of an introspection differ from the recording's; the
    // arithmetic is pinned by src/server/controllers/oauth-tokens.test.ts.
    "response.json.access_token",
    "response.json.refresh_token",
    "response.json.created_at",
    "response.json.device_code",
    "response.json.user_code",
    "response.json.verification_uri_complete",
    "response.location",
    "response.cookies.XSRF-TOKEN.value",
    "db.oauth_device_authorizations.inserted.*.device_code_digest",
    "db.oauth_device_authorizations.inserted.*.user_code_digest",
    "db.oauth_access_grants.inserted.*.token",
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

describe.skipIf(!url)("OAuth device flow", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };
  const written: { codes: Record<string, unknown>[]; tokens: Record<string, unknown>[] } = { codes: [], tokens: [] };

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
      const rewritten = reencryptCookies(request, loaded, SECRET_KEY_BASE, now, freshenHandoffs);
      return {
        ...rewritten,
        headers: { ...rewritten.headers, "x-forwarded-for": rewritten.remoteIp ?? "127.0.0.1" },
      } as never;
    },
    compare: COMPARE,
  });

  afterAll(async () => {
    if (process.env.WRITE_NODE_DEVICE && written.codes.length > 0)
      writeFileSync(process.env.WRITE_NODE_DEVICE, `${JSON.stringify(written, null, 2)}\n`);
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
        const body = (actual.response.json ?? {}) as Record<string, unknown>;
        const rowsOf = (table: string) =>
          (actual.db?.[table] as { inserted?: Record<string, unknown>[] } | undefined)?.inserted ?? [];
        const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

        // Helpers::UniqueToken is SecureRandom.urlsafe_base64(32): 43 characters of the URL-safe alphabet, no padding.
        for (const row of rowsOf("oauth_access_tokens")) {
          expect(row.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
          expect(row.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
          expect(body.access_token).toBe(row.token);
          expect(body.refresh_token).toBe(row.refresh_token);
        }
        for (const row of rowsOf("oauth_access_grants")) expect(row.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

        // OauthDeviceAuthorization stores only digests: SHA256 of the device code and of the normalised user code.
        for (const row of rowsOf("oauth_device_authorizations")) {
          expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
          expect(body.user_code).toMatch(/^GRD-[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
          expect(row.device_code_digest).toBe(sha256(body.device_code as string));
          expect(row.user_code_digest).toBe(sha256((body.user_code as string).replaceAll("-", "")));
          expect(body.verification_uri_complete).toBe(`${body.verification_uri}?user_code=${body.user_code as string}`);
        }

        for (const row of rowsOf("oauth_device_authorizations"))
          written.codes.push({
            example: name,
            device_code: body.device_code,
            user_code: body.user_code,
            device_code_digest: row.device_code_digest,
            user_code_digest: row.user_code_digest,
            scopes: row.scopes,
            poll_interval_seconds: row.poll_interval_seconds,
          });
        for (const row of rowsOf("oauth_access_tokens"))
          written.tokens.push({
            example: name,
            access_token: row.token,
            refresh_token: row.refresh_token,
            scopes: row.scopes,
            grant: rowsOf("oauth_access_grants")[0] ?? null,
          });

        // The handoff parked in the session is the one the login redirect carries.
        const location = actual.response.location as string | undefined;
        if (location !== undefined && /\/login\?next=/u.test(location) && /-get-oauth-device-/u.test(name)) {
          const handoff = /%3Fhandoff%3D([A-Za-z0-9_-]{22})$/u.exec(location)?.[1];
          expect(handoff).toBeDefined();
          const cookie = fixture.sessionCookie!;
          const mine = handoffsOf(SECRET_KEY_BASE, cookie, actual.response)!;
          const theirs = handoffsOf(fixture.secretKeyBase!, cookie, fixture.exchanges[index]!.response)!;
          expect(mine[handoff!]).toMatchObject({ created_at: expect.any(Number) });
          const userCodes = (handoffs: Record<string, { user_code: string }>) =>
            Object.values(handoffs)
              .map((entry) => entry.user_code)
              .sort();
          expect(userCodes(mine)).toEqual(userCodes(theirs));
          expect(Object.keys(mine).sort((a, b) => a.localeCompare(b)).length).toBe(Object.keys(theirs).length);
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
