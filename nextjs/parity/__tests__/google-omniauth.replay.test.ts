import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readEncryptedCookie } from "@/server/auth/rails-cookies";
import { railsCookieSecrets } from "@/server/auth/rails-session-config";
import { closeAllRedis } from "@/server/infra/redis";

import { NOW_TOLERANCE_SECONDS, resolveTimeToken } from "../src/canonical";
import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { type CapturedHttp, loadFixture } from "../src/fixture";
import { keptHttpHeaders } from "../src/http";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays google_omniauth_parity_spec.rb: the Google callback, from the token exchange to the sign-in. The stand-in serves the WebMock exchanges of
// the recording in order (the token, tokeninfo and userinfo answers and the picture host), refuses a call that is not the next one Rails made, and
// keeps what Node sent. The bucket and the password-breach lookup are stand-ins of their own: the upload is held to what Rails put there (bytes,
// checksum, type, ACL) and to happening after the rows were committed. A "hands ..." example must reach the stand-in Rails and make no provider
// call: the code is single-use.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = [path.join("parity/fixtures/requests", "google_omniauth_parity_spec")];
const ROUTE_FLAGS = "nextjs_omniauth_phases";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const CLIENT_ENV = {
  ...(testEnv("GOOGLE_CLIENT_ID") ? { GOOGLE_CLIENT_ID: testEnv("GOOGLE_CLIENT_ID")! } : {}),
};
const SEED_AGE_MS = 2000;
const TIME_TOKEN = /<now(?:[+-]\d+[smh])?>/gu;
const PARITY_NOW = Date.now();
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item. The product reindexes a user save triggers ask Elasticsearch for documents the
// replay does not hold, and Node then queues the fallback job Rails never needed.
// GenerateSubscribePreviewJob: Rails' factories took its until_executed lock before the request; Node takes it as production does.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker", "GenerateSubscribePreviewJob"]);
// Active Storage's analysis of an attached picture: the recording runs ActiveJob on the test adapter, which the fixture does not hold, so the
// replay checks the job on its own (the spec asserts the same payload on the Rails side).
const ANALYZE_JOB = "ActiveStorage::AnalyzeJob";
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

let jobOrder: string[] = [];

// A delayed job (the Elasticsearch update of an attached purchase, `perform_in(10.seconds)`) carries `at`. The fixture holds it as "<now+10s>", so
// it is reported as that delay from the drain (measured on the server's clock, since the fake Date lags under load), snapped to the even second the
// request's latency took it off; a delay within the tolerance of "<now>" is reported as none.
function snappedDelayMs(at: number): number {
  const remaining = Math.max(0, at * 1000 - (realNow() + clockOffset));
  return remaining <= NOW_TOLERANCE_SECONDS * 1000 ? 0 : Math.round(remaining / 2000) * 2000;
}
function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {},
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      const sequence = new Map<RawJob, number>();
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
        if (item.wrapped === "MailDeliveryJob" || item.wrapped === ANALYZE_JOB || IGNORED_JOBS.has(item.class))
          continue;
        const job = {
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: new Date(Date.now() + snappedDelayMs(item.at)) }),
        };
        jobs.push(job);
        // The moment BullMQ added the job is the order Rails enqueued them in.
        sequence.set(job, Number(await redis.hget(key, "timestamp")));
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
      // Rails' order where the recording has the class, so two jobs of one save compare as they were pushed.
      const rank = (job: RawJob) => {
        const at = jobOrder.indexOf(job.class);
        return at === -1 ? jobOrder.length : at;
      };
      return jobs.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (sequence.get(a) ?? Infinity) - (sequence.get(b) ?? Infinity) ||
          jobKey(a).localeCompare(jobKey(b)),
      );
    },
  };
}

// ActiveJob jobs reach Sidekiq's own queue (the wrapper is not a BullMQ job), so the analysis is read from the list.
async function analyzeJobs(redis: Redis) {
  const found: { queue: string; arguments: unknown }[] = [];
  for (const raw of await redis.lrange("queue:default", 0, -1)) {
    const item = JSON.parse(raw) as { queue: string; wrapped?: string; args: { arguments: unknown }[] };
    if (item.wrapped === ANALYZE_JOB) found.push({ queue: item.queue, arguments: item.args[0]?.arguments });
  }
  return found;
}

// The bucket the recording uploaded to, answered from memory: the replay holds Node to the upload Rails made (checksum, type, ACL, bytes) and
// to the order (rows first, upload after the commit). Rails' reads of the bucket (an existence check, the download for the analysis) are not
// repeated by Node, which analyses the bytes it holds.
type Put = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  rows: Record<string, unknown>[];
};
const PWNED_URL = /^https:\/\/api\.pwnedpasswords\.com\//u;
const BUCKET_URL = /^https?:\/\/localhost:9010\//u;

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.active_storage_blobs.inserted.*.key",
    // A new account's random password, external id and OTP secret.
    "db.users.inserted.*.encrypted_password",
    "db.users.updated.*.changes.encrypted_password",
    "db.users.inserted.*.external_id",
    "db.users.inserted.*.otp_secret_key",
    // The recording sent no User-Agent; the replay's client sends its own.
    "db.signup_events.inserted.*.browser",
    "db.signup_events.inserted.*.browser_fingerprint",
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
  // Addressable's query_values is a Hash: a repeated name keeps its last value.
  const pairs = [...new Map(parsed.searchParams)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

describe.skipIf(!url)("Google OmniAuth", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  let standIn: Server;
  let bucket: Server;
  let pwned: Server;
  const pwnedPrefixes: string[] = [];
  const objects = new Map<string, Buffer>();
  const puts: Put[] = [];
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
    bucket = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          const objectPath = decodeURIComponent((request.url ?? "").split("?")[0]!);
          if (request.method === "PUT") {
            const body = Buffer.concat(chunks);
            objects.set(objectPath, body);
            // The key of the object is the key of a blob row, and that row exists when the upload happens.
            const key = objectPath.split("/").slice(2).join("/");
            const rows = await sql.query(
              "SELECT `id`, `key`, `byte_size` FROM `active_storage_blobs` WHERE `key` = ?",
              [key],
            );
            puts.push({ path: objectPath, headers: request.headers, body, rows });
            return void response.writeHead(200, { etag: `"${"0".repeat(32)}"` }).end();
          }
          const object = objects.get(objectPath);
          if (object === undefined) return void response.writeHead(404).end();
          response
            .writeHead(200, { "content-length": object.length })
            .end(request.method === "HEAD" ? undefined : object);
        })();
      });
    });
    await new Promise<void>((resolve) => bucket.listen(0, "127.0.0.1", resolve));
    // api.pwnedpasswords.com: the recorded answer is an empty range.
    pwned = createServer((request, response) => {
      pwnedPrefixes.push((request.url ?? "").replace("/range/", ""));
      response.writeHead(200, { "content-type": "text/plain" }).end("");
    });
    await new Promise<void>((resolve) => pwned.listen(0, "127.0.0.1", resolve));
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
          JSON.stringify(normalizedForm(expected.body)) === JSON.stringify(normalizedForm(call.body)) &&
          // An OAuth 1.0a call is compared whole; a Basic or Bearer credential by the digest the recorder keeps of it.
          (expected.authorization !== undefined
            ? expected.authorization === call.authorization
            : expected.headers?.authorization === undefined ||
              expected.headers.authorization ===
                keptHttpHeaders(request.headers as Record<string, string>).authorization);
        if (!matches) {
          mismatches.push(
            `call ${received.length}: sent ${call.method} ${call.url} ${call.body} ${call.authorization ?? ""}, Rails made ${
              expected
                ? `${expected.method} ${expected.url} ${expected.body ?? ""} ${expected.authorization ?? ""}`
                : "no call"
            }`,
          );
          return void response.writeHead(599).end("parity: not the next recorded call");
        }
        const answer = expected.response;
        response.writeHead(answer.status ?? 200, answer.contentType ? { "content-type": answer.contentType } : {});
        response.end(
          answer.bodyBase64 !== undefined
            ? Buffer.from(answer.bodyBase64, "base64")
            : resolveTimes(answer.body ?? "", new Date()),
        );
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
      PWNED_PASSWORDS_ORIGIN: `http://127.0.0.1:${(pwned.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      ...CLIENT_ENV,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: `http://127.0.0.1:${(bucket.address() as { port: number }).port}`,
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
    await new Promise((resolve) => bucket.close(resolve));
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
    // Rails saw a second pass between the factory that made a row and the request that changes it; a column with second precision shows that
    // change only when it does. Seeded rows are made a little older than the request, inside the tolerance of "<now>".
    get seedClock() {
      return new Date(Date.now() - SEED_AGE_MS);
    },
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
    delete session.two_factor_auth_token_sent_at;
    // A new account's random password: Devise keeps the head of its salt in the session key.
    const key = session["warden.user.user.key"] as unknown[] | undefined;
    if (key) key[1] = "<salt>";
    // The sign-in time, whenever the recording was made.
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
      // The attach path pulls in the S3 client, which is slow to compile: warm it with the first fixture that uploads.
      const warm = cases.filter(([name]) => name.includes("downloaded-at-its-larger-size"));
      for (const [, file, index] of [...warm, ...cases.slice(0, 2)])
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
        const recordedPuts = exchange.http.filter((call) => BUCKET_URL.test(call.url) && call.method === "PUT");
        recorded = exchange.http.filter((call) => !BUCKET_URL.test(call.url) && !PWNED_URL.test(call.url));
        pwnedPrefixes.length = 0;
        jobOrder = exchange.jobs.map((job) => job.class);
        objects.clear();
        puts.length = 0;
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
        // Every call carries the OAuth header Rails signed.
        received.forEach((call, at) => {
          if (recorded[at]!.authorization !== undefined) expect(call.authorization).toBe(recorded[at]!.authorization);
        });
        // The upload: what Rails put in the bucket, once, after the blob and its attachment were committed.
        expect(puts).toHaveLength(recordedPuts.length);
        for (const [at, rails] of recordedPuts.entries()) {
          const node = puts[at]!;
          expect(node.rows).toHaveLength(1);
          expect(node.path).toBe(`/gumroad-specs/${String(node.rows[0]!.key)}`);
          expect(String(node.rows[0]!.key)).toMatch(/^[a-z0-9]{28}$/u);
          expect(node.body.toString("base64")).toBe(rails.bodyBase64);
          expect(node.headers["content-md5"]).toBe(rails.headers?.["content-md5"]);
          expect(node.headers["content-type"]).toBe(rails.contentType);
          expect(node.headers["x-amz-acl"]).toBe(rails.headers?.["x-amz-acl"]);
        }
        // The password check of a new account: one range lookup per recorded one, on a prefix of the (random) password's hash.
        expect(pwnedPrefixes).toHaveLength(exchange.http.filter((call) => PWNED_URL.test(call.url)).length);
        expect(pwnedPrefixes.every((prefix) => /^[0-9A-F]{5}$/u.test(prefix))).toBe(true);
        const analyze = await analyzeJobs(redis);
        if (recordedPuts.length === 0) {
          if (analyze.length > 0) throw new Error(`analysis jobs ${JSON.stringify(analyze)}, Rails enqueues none`);
        } else {
          const [blob] = await sql.query("SELECT `id` FROM `active_storage_blobs` ORDER BY `id` DESC LIMIT 1");
          const expectedJob = [
            {
              queue: "default",
              arguments: [{ _aj_globalid: `gid://gumroad/ActiveStorage::Blob/${String(blob!.id)}` }],
            },
          ];
          if (JSON.stringify(analyze) !== JSON.stringify(expectedJob))
            throw new Error(`analysis job ${JSON.stringify(analyze)}, Rails enqueues ${JSON.stringify(expectedJob)}`);
        }
        // The session the callback leaves behind: the flash, the spent OmniAuth keys and the return entry.
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
