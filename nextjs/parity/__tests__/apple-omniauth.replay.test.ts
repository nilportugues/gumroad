import { createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { resolveTimeToken } from "../src/canonical";
import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { type CapturedHttp, loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays apple_omniauth_parity_spec.rb: the request phase of Sign in with Apple and the form_post callback. The stand-in serves the recorded
// JWKS and token answers in order and keeps what Node sent. The client secret of the token call is an ES256 JWT that differs on every signing,
// so it is checked apart: the public half of the committed test key must verify it, and its header and claims must be the recorded ones.
// The id_token and the nonce cookie of a recording are only valid at the instant they were made, so the server and the test run on a clock
// pinned to it. A "hands ..." example must reach the stand-in Rails; it may fetch Apple's keys (an idempotent GET) and never spends the code.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = [path.join("parity/fixtures/requests", "apple_omniauth_parity_spec")];
const ROUTE_FLAGS = "nextjs_omniauth_phases";
const TEST_KEY = readFileSync(path.join(process.cwd(), "..", "spec/support/fixtures/apple_web_test_key.pem"), "utf8");
// What the recording ran with (the test environment has none of these).
const CLIENT_ENV = {
  APPLE_WEB_CLIENT_ID: "com.example.gumroad.web",
  APPLE_WEB_TEAM_ID: "TEAM123456",
  APPLE_WEB_KEY_ID: "KEY1234567",
  APPLE_WEB_PRIVATE_KEY: TEST_KEY,
};
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const PWNED_ORIGIN = "https://api.pwnedpasswords.com";
const COOKIE = "_apple_oauth_nonce";
const COOKIE_TTL_SECONDS = 300;
const CLIENT_SECRET_TTL_SECONDS = 60;
const CLOCK_SLACK_SECONDS = 10;
const SIGN_IN_SPREAD_SECONDS = 240;
// The server's clock is the real clock plus a fixed offset; the test's fake Date is re-anchored to that formula before every example.
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
function cookieExpiry(value: unknown): number | null {
  if (typeof value !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(decodeURIComponent(value).split("--")[0]!, "base64").toString("utf8")) as {
      _rails?: { exp?: string };
    };
    const expiry = payload._rails?.exp;
    return expiry ? Date.parse(expiry) : null;
  } catch {
    return null;
  }
}

// `retired_by_adoption_at` is `Time.current.iso8601` inside a json_data string, so the diff cannot see it is a time. Each side's stamp is
// checked to be the moment of the sign-in and then masked, which leaves the rest of the document compared as it is.
const RETIRED_AT = /("retired_by_adoption_at":")([^"]+)(")/gu;
type UpdatedRows = Record<string, { updated?: { changes: Record<string, unknown[]> }[] }>;
function maskRetirementTimes(exchange: { expected: { db: unknown }; actual: { db: unknown } }): void {
  const masked = [exchange.expected, exchange.actual].map((side) =>
    ((side.db as UpdatedRows).merchant_accounts?.updated ?? []).map((row) => {
      const change = row.changes.json_data;
      return (change ?? []).map((value) =>
        typeof value !== "string"
          ? value
          : value.replace(RETIRED_AT, (_match, open: string, stamp: string, close: string) => {
              if (side === exchange.actual)
                expect(Math.abs(Date.parse(stamp) - Date.now())).toBeLessThan(SIGN_IN_SPREAD_SECONDS * 1000);
              return `${open}<now>${close}`;
            }),
      );
    }),
  );
  expect(masked[1]).toEqual(masked[0]);
}

const TIME_TOKEN = /<now(?:[+-]\d+[smh])?>/gu;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item. The product reindexes a user save triggers ask Elasticsearch for documents the
// replay does not hold, and Node then queues the fallback job Rails never needed.
// GenerateSubscribePreviewJob: Rails' factories took its until_executed lock before the request; Node takes it as production does.
// A job with an `until_executing` lock is pushed once however often Rails enqueues it: the recording's test adapter has no lock, Node's queue has.
const LOCKED_JOBS = new Set(["RefreshMerchantAccountProductsRecommendationEligibilityJob"]);
const withoutLockedDuplicates = (jobs: { class: string; args: unknown }[]) =>
  jobs.filter(
    (job, at) => !LOCKED_JOBS.has(job.class) || jobs.findIndex((other) => jobKey(other) === jobKey(job)) === at,
  );
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker", "GenerateSubscribePreviewJob"]);
// Redis does not keep the order jobs were enqueued in: the ones a new account makes are put in the order Rails enqueues them (after commit, then after confirmation).
// The adoption of an unconfirmed account commits its sign-in changes (a reindex of the subscriptions' email) before its payout changes.
const ENQUEUE_ORDER = [
  "ReindexSubscriptionCurrentEmailWorker",
  "RefreshMerchantAccountProductsRecommendationEligibilityJob",
  "RefreshUserProductsRecommendationEligibilityJob",
  "GenerateUsernameJob",
  "AttachPastPurchasesToUserWorker",
];
const rank = (job: { class: string }) =>
  ENQUEUE_ORDER.includes(job.class) ? ENQUEUE_ORDER.indexOf(job.class) : ENQUEUE_ORDER.length;
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// A delayed job (the Elasticsearch update of an attached purchase, `perform_in(4.seconds)`, a reindex 10 seconds out) carries `at`. The fixture holds it
// as "<now+4s>" or "<now+10s>", so it is reported as that delay from the drain, snapped to the even second the request's latency took it off.
function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {},
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data === null) continue;
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as {
          class: string;
          args: unknown[];
          queue: string;
          at?: number;
          wrapped?: string;
        };
        if (item.wrapped === "MailDeliveryJob" || IGNORED_JOBS.has(item.class)) continue;
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined
            ? {}
            : { at: new Date(Date.now() + Math.round(Math.max(0, item.at * 1000 - Date.now()) / 2000) * 2000) }),
        });
      }
      // Jobs still in Ruby are pushed in Sidekiq's own format.
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
          if (item.class === "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper" || IGNORED_JOBS.has(item.class))
            continue;
          jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      return jobs.sort((a, b) => rank(a) - rank(b) || jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    // A new account's random password, external id and OTP secret, and the password an adopted account is given (checked by shape below).
    "db.users.inserted.*.encrypted_password",
    "db.users.updated.*.changes.encrypted_password",
    "db.users.inserted.*.external_id",
    "db.users.inserted.*.otp_secret_key",
    // The state and the nonce of an authorize URL and the signed cookie that remembers the nonce are minted per request: checked apart.
    "response.location",
    "response.body",
    `response.cookies.${COOKIE}.value`,
    "http",
    // The time `mark_retired_by_adoption!` stamps inside the document: masked and compared by maskRetirementTimes.
    "db.merchant_accounts.updated.*.changes.json_data",
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

const PARITY_NOW =
  Math.max(
    ...cases.flatMap(([, file]) => {
      const { exchanges } = loadFixture(file);
      const last = exchanges[exchanges.length - 1]!;
      const response = last.response.cookies?.[COOKIE] as { value?: unknown } | undefined;
      return [cookieExpiry(last.request.cookies?.[COOKIE]), cookieExpiry(response?.value)].filter(
        (expiry): expiry is number => expiry !== null,
      );
    }),
  ) -
  COOKIE_TTL_SECONDS * 1000;

// WebMock normalises a recorded URL (sorted query, decoded); both sides are brought to that form.
function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  const pairs = [...parsed.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${parsed.origin}${parsed.pathname}?${pairs.map(([key, v]) => `${key}=${v}`).join("&")}`;
}

const withoutSecret = (form: [string, string][]) => form.filter(([name]) => name !== "client_secret");

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

describe.skipIf(!url)("Apple OmniAuth", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  let pwned: Server;
  const pwnedPrefixes: string[] = [];
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
          JSON.stringify(withoutSecret(normalizedForm(expected.body))) ===
            JSON.stringify(withoutSecret(normalizedForm(call.body)));
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
    // api.pwnedpasswords.com: the recorded answer is an empty range.
    pwned = createServer((request, response) => {
      pwnedPrefixes.push((request.url ?? "").replace("/range/", ""));
      response.writeHead(200, { "content-type": "text/plain" }).end("");
    });
    await new Promise<void>((resolve) => pwned.listen(0, "127.0.0.1", resolve));
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
      PWNED_PASSWORDS_ORIGIN: `http://127.0.0.1:${(pwned.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      ...CLIENT_ENV,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
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
    pwned.close();
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
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) =>
      // The return entry holds the recording's clock; Rails refuses it after 15 minutes, so it is moved to the replay's.
      reencryptCookies(request, loaded, SECRET_KEY_BASE, now, (session) => {
        const entry = (session as { social_connect_return?: { created_at?: unknown } }).social_connect_return;
        if (entry && typeof entry.created_at === "number") entry.created_at = Math.floor(now.getTime() / 1000);
        return session;
      }),
    compare: COMPARE,
  });

  const sessionOf = (name: string, cookies: Record<string, { value?: unknown }> | undefined) => {
    const raw = cookies?.[name]?.value;
    if (raw === undefined) return undefined;
    const session = readEncryptedCookie(railsCookieSecrets(), name, decodeURIComponent(String(raw))) as Record<
      string,
      unknown
    >;
    // Minted per session, so a request that starts one (no earlier request set it) differs on both.
    delete session.session_id;
    delete session._csrf_token;
    // The sign-in instant is the recording's (a recording lasts a minute or two) and the state is random: both are checked by shape.
    const state = session["omniauth.state"];
    if (typeof state === "string" && /^[0-9a-f]{48}$/u.test(state)) session["omniauth.state"] = "<state>";
    // The key's second element is the salt of the password digest: random for an account whose password was just set (the sign-in key is
    // checked against the stored digest where it matters), so only its bcrypt version and cost compare.
    const wardenKey = session["warden.user.user.key"] as [unknown, string] | undefined;
    if (wardenKey && /^\$2a\$04\$.{22}$/u.test(wardenKey[1])) wardenKey[1] = "$2a$04$<salt>";
    const warden = session["warden.user.user.session"] as { last_sign_in_at?: number } | undefined;
    if (
      warden?.last_sign_in_at !== undefined &&
      Math.abs(warden.last_sign_in_at - Date.now() / 1000) < SIGN_IN_SPREAD_SECONDS
    )
      warden.last_sign_in_at = 0;
    return session;
  };

  const decodeJwt = (jwt: string) => {
    const [header = "", claims = "", signature = ""] = jwt.split(".");
    const json = (segment: string) =>
      JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
    return { header: json(header), claims: json(claims), signing: `${header}.${claims}`, signature };
  };

  // The client secret Node signed: the test key verifies it, and it says what the recorded one said.
  const expectClientSecret = (sent: Received, recordedCall: CapturedHttp) => {
    const secret = new URLSearchParams(sent.body).get("client_secret")!;
    const want = decodeJwt(new URLSearchParams(recordedCall.body).get("client_secret")!);
    const got = decodeJwt(secret);
    const publicKey = createPublicKey(TEST_KEY);
    expect(
      verify(
        "sha256",
        Buffer.from(got.signing),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(got.signature, "base64url"),
      ),
    ).toBe(true);
    expect(got.header).toEqual(want.header);
    expect({ ...got.claims, iat: 0, exp: 0 }).toEqual({ ...want.claims, iat: 0, exp: 0 });
    const issuedAt = got.claims.iat as number;
    expect(got.claims.exp).toBe(issuedAt + CLIENT_SECRET_TTL_SECONDS);
    expect(Math.abs(issuedAt - Date.now() / 1000)).toBeLessThan(CLOCK_SLACK_SECONDS);
  };

  // The authorize redirect and the cookie of the request phase, which carry what is random per request.
  const expectRequestPhase = (
    expected: { response: { location?: string; cookies?: Record<string, unknown> } },
    actual: { response: { location?: string; cookies?: Record<string, unknown> } },
  ) => {
    const want = new URL(expected.response.location!);
    const got = new URL(actual.response.location!);
    expect(got.origin + got.pathname).toBe(want.origin + want.pathname);
    const query = (target: URL) => Object.fromEntries(target.searchParams);
    expect({ ...query(got), state: "", nonce: "" }).toEqual({ ...query(want), state: "", nonce: "" });
    expect(query(got).state).toMatch(/^[0-9a-f]{48}$/u);
    const message = (cookie: unknown) => {
      const value = (cookie as { value: string }).value;
      const payload = JSON.parse(Buffer.from(decodeURIComponent(value).split("--")[0]!, "base64").toString("utf8")) as {
        _rails: { data: Record<string, string>; exp: string; pur: string };
      };
      return payload._rails;
    };
    const wantCookie = actual.response.cookies?.[COOKIE] as Record<string, unknown>;
    const sent = message(wantCookie);
    const recordedCookie = message(expected.response.cookies?.[COOKIE]);
    // The nonce of the URL is the nonce in the cookie, and the cookie says what the recorded one said about the page to return to.
    expect(sent.data.nonce).toBe(query(got).nonce);
    expect(sent.data.nonce).toHaveLength(43);
    expect({ ...sent.data, nonce: "" }).toEqual({ ...recordedCookie.data, nonce: "" });
    expect(sent.pur).toBe(recordedCookie.pur);
    expect(Math.abs(Date.parse(sent.exp) - Date.now() - COOKIE_TTL_SECONDS * 1000)).toBeLessThan(
      CLOCK_SLACK_SECONDS * 1000,
    );
    const { value: _sentValue, ...sentAttributes } = wantCookie as { value: string };
    const { value: _wantValue, ...wantAttributes } = expected.response.cookies?.[COOKIE] as { value: string };
    expect(sentAttributes).toEqual(wantAttributes);
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
        exchange.jobs = withoutLockedDuplicates(exchange.jobs);
        const isPwned = (call: CapturedHttp) => call.url.startsWith(PWNED_ORIGIN);
        recorded = exchange.http.filter((call) => !isPwned(call));
        pwnedPrefixes.length = 0;
        received.length = 0;
        mismatches.length = 0;
        handedBack.length = 0;
        // Whatever Node cannot prove goes to Rails whole, before the code is spent.
        if (path.basename(name).includes("-hands-")) {
          const handed = await replayFixtureExchange(fixture, index, replayOptions());
          // Apple's keys are fetched to judge the id_token before the account is looked at: an idempotent GET Rails repeats.
          expect(received.length).toBeLessThanOrEqual(1);
          expect(received.every((call) => call.method === "GET" && call.url.endsWith("/auth/keys"))).toBe(true);
          expect(mismatches).toEqual([]);
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: exchange.request.method,
            url: exchange.request.query ? `${exchange.request.path}?${exchange.request.query}` : exchange.request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        const replayed = await replayFixtureExchange(fixture, index, replayOptions());
        maskRetirementTimes(replayed.exchanges[0]!);
        assertParity(replayed);
        // A password Node set for an account it created or adopted is a bcrypt digest of the cost Rails used, and an adopted account's differs.
        const digests = (await client.user.findMany({ select: { id: true, encrypted_password: true } })).map(
          (row) => row.encrypted_password,
        );
        const changed = (
          replayed.exchanges[0]!.expected.db as Record<string, { updated?: { changes: Record<string, unknown[]> }[] }>
        ).users?.updated?.find((row) => row.changes.encrypted_password);
        if (changed) {
          expect(digests).not.toContain(changed.changes.encrypted_password![0]);
          expect(digests).toContainEqual(expect.stringMatching(/^\$2a\$04\$/u));
        }
        if (name.includes("creates-an-account")) expect(digests).toContainEqual(expect.stringMatching(/^\$2a\$04\$/u));
        // The port made the provider calls Rails made, in the same order and with the same credentials, and no others.
        expect(mismatches).toEqual([]);
        expect(received).toHaveLength(recorded.length);
        // The new account's random password is looked up by the first five characters of its SHA-1, as devise-pwned_password does.
        expect(pwnedPrefixes).toHaveLength(exchange.http.filter(isPwned).length);
        expect(pwnedPrefixes.every((prefix) => /^[0-9A-F]{5}$/u.test(prefix))).toBe(true);
        received.forEach((call, at) => {
          if (call.url === TOKEN_URL) expectClientSecret(call, recorded[at]!);
        });
        if (exchange.request.path === "/users/auth/apple")
          expectRequestPhase(replayed.exchanges[0]!.expected, replayed.exchanges[0]!.actual);
        // The session the callback leaves behind: the flash, the spent OmniAuth keys and the return entry.
        const { expected, actual } = replayed.exchanges[0]!;
        const sessionName = fixture.sessionCookie!;
        if (sessionOf(sessionName, expected.response.cookies) === undefined) return;
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
