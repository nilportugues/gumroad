import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validPassword } from "@/server/auth/devise-password";
import { deriveRailsCookieSecrets, readEncryptedCookie, readSignedCookie } from "@/server/auth/rails-cookies";
import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture, type Fixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the POST/DELETE side of the authentication pages (spec/requests/auth_mutations_parity_spec.rb): the Devise redirects,
// POST /login, logout and the two-factor actions. Each fixture is a CSRF fetch, optionally a login, and the request under test; the
// last one is replayed against `next dev`. On top of the status, headers, cookies, rows and jobs the harness compares, the decrypted
// session of the response is compared with the one Rails wrote (the harness skips the session cookie's value: it is encrypted with a
// random IV), apart from the ids and times that differ by construction.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["auth_mutations_parity_spec", "auth_account_parity_spec", "review_reminders_parity_spec"];
const ROUTE_FLAGS = [
  "nextjs_auth_devise_redirects",
  "nextjs_auth_login_writes",
  "nextjs_auth_logout",
  "nextjs_auth_two_factor_writes",
  "nextjs_auth_passwords",
  "nextjs_auth_confirmations",
  "nextjs_user_invalidate_sessions",
  "nextjs_users_session_endpoints",
  "nextjs_users_email_unsubscribe",
  "nextjs_review_reminders",
].join(",");
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];
// Session keys that differ by construction: the session id is random, the CSRF token is Rails'.
const SESSION_IGNORED = new Set(["session_id", "_csrf_token"]);
const SECONDS_TOLERANCE = 30;

// Mail jobs of a request spec go through the test adapter, so the fixtures hold none: they are kept apart and asserted on directly.
const mailJobs: RawJob[] = [];
// Rails' factories took the until_executed lock of GenerateSubscribePreviewJob before the request; Node takes it as production does.
const IGNORED_JOBS = new Set(["GenerateSubscribePreviewJob"]);
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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as { class: string; args: unknown[]; queue: string };
        jobs.push({ class: item.class, args: item.args, queue: item.queue });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
          jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at: number };
        jobs.push({ class: item.class, args: item.args, queue: item.queue, at: item.at });
      }
      mailJobs.length = 0;
      mailJobs.push(...jobs.filter((job) => job.class === MAIL_WRAPPER));
      return jobs.filter((job) => job.class !== MAIL_WRAPPER && !IGNORED_JOBS.has(job.class));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.body",
    // Every cookie value is encrypted or signed with a random IV; the session, remember and two-factor payloads are compared decrypted.
    "response.cookies.*.value",
    "db.versions",
    "db.users.updated.*.changes.reset_password_sent_at",
    // Random by construction: the digest of the emailed token and the bcrypt hash (checked below).
    "db.users.updated.*.changes.reset_password_token",
    "db.users.updated.*.changes.encrypted_password",
    "db.users.updated.*.changes.updated_at",
    "db.seller_profiles.inserted.*.created_at",
    "db.seller_profiles.inserted.*.updated_at",
    "jobs.*.at",
    "http",
  ],
};

// The mail each example enqueues (the fixtures hold none, see mailJobs): name fragment, mailer, method.
const MAILS = [
  ["starts-email-two-factor", "TwoFactorAuthenticationMailer", "authentication_token"],
  ["resends-the-token", "TwoFactorAuthenticationMailer", "authentication_token"],
  ["switches-to-email", "TwoFactorAuthenticationMailer", "authentication_token"],
  ["asks-for-two-factor-authentication-first", "TwoFactorAuthenticationMailer", "authentication_token"],
  ["sends-the-reset-instructions", "UserSignupMailer", "reset_password_instructions"],
] as const;

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

function decryptedSession(secretKeyBase: string, fixture: Fixture, value: string | undefined): Record<string, unknown> | null {
  if (!value || !fixture.sessionCookie) return null;
  const decoded = readEncryptedCookie(deriveRailsCookieSecrets(secretKeyBase), fixture.sessionCookie, value, new Date(0));
  return decoded !== null && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
}

// The session a response leaves, without the ids and the sign-in time (seconds since the epoch, compared within a tolerance).
function comparableSession(session: Record<string, unknown> | null): Record<string, unknown> | null {
  if (session === null) return null;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(session)) {
    if (SESSION_IGNORED.has(key)) continue;
    copy[key] = value;
  }
  return copy;
}

function sameSessions(expected: Record<string, unknown> | null, actual: Record<string, unknown> | null): void {
  const clean = (session: Record<string, unknown> | null) => {
    const copy = comparableSession(session);
    if (copy === null) return null;
    const warden = copy["warden.user.user.session"] as { last_sign_in_at?: number } | undefined;
    if (warden?.last_sign_in_at !== undefined) copy["warden.user.user.session"] = { last_sign_in_at: "<time>" };
    // Devise's authenticatable_salt is the bcrypt version, cost and a random salt: the version and cost compare.
    const key = copy["warden.user.user.key"] as [number[], string] | undefined;
    if (key) copy["warden.user.user.key"] = [key[0], key[1].slice(0, 7)];
    // The tokens' salt is the bcrypt version, cost and salt of the password: equal for the same row.
    if (typeof copy.two_factor_auth_token_sent_at === "number") copy.two_factor_auth_token_sent_at = "<time>";
    return copy;
  };
  const want = JSON.stringify(clean(expected));
  const got = JSON.stringify(clean(actual));
  if (want !== got) throw new Error(`session differs\nrails: ${want}\nnext:  ${got}`);
}

describe.skipIf(!url)("mutations of the authentication pages", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let pwned: Server;
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
    // api.pwnedpasswords.com: the recorded answer is an empty range.
    pwned = createServer((_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end(""));
    await new Promise<void>((resolve) => pwned.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    const pwnedPort = (pwned.address() as { port: number }).port;
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      PWNED_PASSWORDS_ORIGIN: `http://127.0.0.1:${pwnedPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DEVISE_SECRET_KEY") ? { DEVISE_SECRET_KEY: testEnv("DEVISE_SECRET_KEY")! } : {}),
      ...(testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION") ? { SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION")! } : {}),
      ...(testEnv("SECURE_EXTERNAL_ID__KEYS__1") ? { SECURE_EXTERNAL_ID__KEYS__1: testEnv("SECURE_EXTERNAL_ID__KEYS__1")! } : {}),
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = (file: string) => ({
    sql,
    redis: { reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries) },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    // Behind Rails' load balancer the client address is the X-Forwarded-For entry; the recording's was 127.0.0.1.
    rewriteRequest: (request: Parameters<typeof reencryptCookies>[0], loaded: Parameters<typeof reencryptCookies>[1], now: Date) => {
      const rewritten = reencryptCookies(request, loaded, SECRET_KEY_BASE, now);
      return { ...rewritten, headers: { ...rewritten.headers, "x-forwarded-for": rewritten.remoteIp ?? "127.0.0.1" } };
    },
    compare: COMPARE,
    file,
  });

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    pwned?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it("compiles the handlers", async () => {
    for (const [, file, index] of [
      cases.find(([name]) => name.includes("signs-in-with-an-email")) ?? cases[0]!,
      cases.find(([name]) => name.includes("signs-out-with-delete")) ?? cases[0]!,
      cases.find(([name]) => name.includes("signs-in-with-the-token")) ?? cases[0]!,
    ]) {
      const { file: _file, ...options } = replayOptions(file);
      await replayFixtureExchange(file, index, options).catch(() => undefined);
    }
  }, FIRST_COMPILE_TIMEOUT_MS);

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const { file: _file, ...options } = replayOptions(file);
        const result = await replayFixtureExchange(fixture, index, options);
        assertParity(result);
        const { expected, actual } = result.exchanges[0]!;
        const sessionCookie = fixture.sessionCookie;
        if (sessionCookie && fixture.secretKeyBase) {
          const rails = decryptedSession(fixture.secretKeyBase, fixture, expected.response.cookies?.[sessionCookie]?.value as string | undefined);
          const node = decryptedSession(SECRET_KEY_BASE, fixture, actual.response.cookies?.[sessionCookie]?.value as string | undefined);
          sameSessions(rails, node);
          // A sign-in stamps the session with the time it happened.
          const stamp = (session: Record<string, unknown> | null) => (session?.["warden.user.user.session"] as { last_sign_in_at?: number } | undefined)?.last_sign_in_at;
          const before = decryptedSession(fixture.secretKeyBase, fixture, fixture.exchanges[index]!.request.cookies?.[sessionCookie]);
          if (stamp(rails) !== undefined && stamp(rails) !== stamp(before)) expect(Math.abs(stamp(node)! - Date.now() / 1000)).toBeLessThan(SECONDS_TOLERANCE);
        }
        // The mail jobs of a request spec go through the test adapter, so the fixture holds none: the port must enqueue the token mail.
        const mail = MAILS.find(([fragment]) => name.includes(fragment));
        if (mail) {
          expect(mailJobs).toHaveLength(1);
          const wrapped = (mailJobs[0]!.args as { job_class: string; queue_name: string; arguments: unknown[] }[])[0]!;
          expect(wrapped).toMatchObject({ job_class: "MailDeliveryJob", queue_name: "critical" });
          expect(wrapped.arguments.slice(0, 2)).toEqual([mail[1], mail[2]]);
        } else {
          expect(mailJobs).toHaveLength(0);
        }
        // The new password verifies with the hash Node wrote.
        if (name.includes("put-users-forgot-password") && !name.includes("refuses") && !name.includes("deleted")) {
          const row = (await client.user.findFirst({ select: { encrypted_password: true } }))!;
          expect(await validPassword(row.encrypted_password, "a-new-long-password-2")).toBe(true);
          expect(row.encrypted_password!.startsWith("$2a$04$")).toBe(true);
        }
        // The cookies the harness cannot compare by value, decrypted.
        const secrets = { rails: deriveRailsCookieSecrets(fixture.secretKeyBase ?? SECRET_KEY_BASE), node: deriveRailsCookieSecrets(SECRET_KEY_BASE) };
        for (const [cookieName, railsCookie] of Object.entries(expected.response.cookies ?? {})) {
          const nodeCookie = actual.response.cookies?.[cookieName];
          if (cookieName.startsWith("_gumroad_two_factor_")) {
            const wantValue = readEncryptedCookie(secrets.rails, cookieName, railsCookie.value as string, new Date(0)) as string;
            const gotValue = readEncryptedCookie(secrets.node, cookieName, nodeCookie?.value as string, new Date(0)) as string;
            expect(gotValue.split(",")[0]).toBe(wantValue.split(",")[0]);
          }
          if (cookieName === "remember_user_token" && railsCookie.value) {
            const wantValue = readSignedCookie(secrets.rails, cookieName, railsCookie.value as string, new Date(0)) as unknown[];
            const gotValue = readSignedCookie(secrets.node, cookieName, nodeCookie?.value as string, new Date(0)) as unknown[];
            expect(gotValue.slice(0, 2)).toEqual(wantValue.slice(0, 2));
          }
        }
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
