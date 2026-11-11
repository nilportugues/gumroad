import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveRailsCookieSecrets, readEncryptedCookie } from "@/server/auth/rails-cookies";
import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { compareExchange, formatDifferences } from "../src/compare";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/url_redirects_parity_spec.rb (WS-16b): the access checks, file deliveries, posts and consumption analytics of
// UrlRedirectsController. Each fixture ends with the request under test, replayed against `next dev` with the route flags on. The
// comparison covers the status, the redirect, the cookies, the body, every row written and every job enqueued. Presigned URLs carry the
// time they were signed at and a signature of it (signed-urls.test.ts pins both against Ruby), so those two parts are masked.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["url_redirects_parity_spec"];
// The objects the spec's files point at (SPEC_OBJECTS in the spec), in the bucket the server signs for.
const SPEC_OBJECTS: Record<string, string> = {
  "specs/billion-dollar-company-chapter-0.pdf": "%PDF-1.4 delivery spec",
  "specs/ScreenRecording.mov": "delivery spec video",
  "specs/magic.mp3": "delivery spec audio",
  "specs/captions.srt": "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
  "attachments/0123456789abcdef0123456789abcdef/movie/hls/index.m3u8":
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nindex_360.m3u8\n#EXT-X-ENDLIST\n",
};
const SPEC_BUCKET = "gumroad-specs";
// The Rails spec froze its clock at 2026-11-09 22:00 UTC; a consumption event's `consumed_at` is a constant the request carries, so
// it is recorded as an age that only holds when the replay's clock is pinned too.
const PARITY_NOW = Date.parse("2026-11-09T22:00:00Z");
// The server's clock is the real clock plus a fixed offset. The worker's fake Date is re-anchored to that same formula before every
// example: `shouldAdvanceTime` ticks 20ms per timer fire however late the fire is, so on a loaded host it falls behind the server.
// performance is not faked, so it reads the real clock.
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;
const ROUTE_FLAGS =
  "nextjs_consumption_analytics,nextjs_media_locations,nextjs_mobile_consumption_analytics,nextjs_mobile_media_locations,nextjs_mobile_url_redirect_delivery,nextjs_mobile_url_redirects,nextjs_url_redirect_check_purchaser,nextjs_url_redirect_confirm,nextjs_url_redirect_delivery,nextjs_url_redirect_download_archive,nextjs_url_redirect_download_page,nextjs_url_redirect_download_product_files,nextjs_url_redirect_expired,nextjs_url_redirect_hls_playlist,nextjs_url_redirect_membership_inactive,nextjs_url_redirect_play,nextjs_url_redirect_read,nextjs_url_redirect_rental_expired,nextjs_url_redirect_show,nextjs_url_redirect_smil,nextjs_url_redirect_stream,nextjs_url_redirect_subtitle_files,nextjs_url_redirect_writes";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker"]);
// A request spec's mail goes through the test adapter, so the fixtures hold none: the port must enqueue it.
const MAIL_WRAPPER = "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper";
const mailJobs: RawJob[] = [];
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as {
          class: string;
          args: unknown[];
          queue: string;
          at?: number;
        };
        if (IGNORED_JOBS.has(item.class)) continue;
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      // Jobs Node has not ported go to Sidekiq's own structures: the queue lists and the schedule set.
      const sidekiqItems = [
        ...(await redis.zrange("schedule", "0", "-1")),
        ...(await Promise.all((await redis.keys("queue:*")).map((key) => redis.lrange(key, "0", "-1")))).flat(),
      ];
      for (const raw of sidekiqItems) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      mailJobs.length = 0;
      mailJobs.push(...jobs.filter((job) => job.class === MAIL_WRAPPER));
      return jobs.filter((job) => job.class !== MAIL_WRAPPER).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

// Rails' versions are off in the test environment (PaperTrail.enabled = false), so the rows Node writes for them are not compared;
// models/concerns/paper-trail.test.ts and the golden of each write pin them.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.purchases.updated.*.changes.updated_at",
    "db.url_redirects.updated.*.changes.updated_at",
    // An encrypted cookie carries a random IV; the test decrypts it instead.
    "response.cookies.confirmed_redirect.value",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
  ],
};

// X-Amz-Date, the date in the credential scope and the signature depend on the second a URL was signed at.
const mask = (value: unknown): unknown => {
  if (typeof value === "string")
    return value
      .replace(/X-Amz-Date=\d{8}T\d{6}Z/gu, "X-Amz-Date=<signed-at>")
      .replace(/(X-Amz-Credential=[^&]*?)%2F\d{8}%2F/gu, "$1%2F<date>%2F")
      .replace(/X-Amz-Signature=[0-9a-f]{64}/gu, "X-Amz-Signature=<signature>")
      .replace(/(?<![-\w])Expires=\d{10}/gu, "Expires=<expires>")
      .replace(/(?<![-\w])Signature=[A-Za-z0-9+/=_~-]+/gu, "Signature=<signature>");
  if (Array.isArray(value)) return value.map(mask);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]));
  return value;
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

describe.skipIf(!url)("url redirect delivery", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  // Stands in for Rails: a request Node hands back arrives here, body and all.
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };
  const secrets = deriveRailsCookieSecrets(SECRET_KEY_BASE);

  beforeAll(async () => {
    const storage = new S3Client({
      region: "us-east-1",
      endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      forcePathStyle: true,
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    });
    for (const [key, body] of Object.entries(SPEC_OBJECTS))
      await storage.send(new PutObjectCommand({ Bucket: SPEC_BUCKET, Key: key, Body: body }));
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
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
    clockOffset = PARITY_NOW - realNow();
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      SECURE_ENCRYPT_KEY: testEnv("SECURE_ENCRYPT_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      ANYCABLE_REDIS_URL: `redis://${redisHost}`,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      ...(testEnv("CLOUDFRONT_PRIVATE_KEY")
        ? { CLOUDFRONT_PRIVATE_KEY: testEnv("CLOUDFRONT_PRIVATE_KEY")!.replaceAll("\\n", "\n") }
        : {}),
      ...(testEnv("CLOUDFRONT_KEYPAIR_ID") ? { CLOUDFRONT_KEYPAIR_ID: testEnv("CLOUDFRONT_KEYPAIR_ID")! } : {}),
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  // The first request to a route compiles it, and the time a write is stamped with is the replay's clock plus the compile: replay one
  // fixture before the first comparison.
  const replayOptions = (file: string, _name: string) => ({
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
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: COMPARE,
    file,
  });

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
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
    "compiles the handler",
    async () => {
      // One request per route shape, so no comparison pays for a route's first compile.
      const shapes = new Map<string, (typeof cases)[number]>();
      for (const entry of cases) {
        const request = loadFixture(entry[1]).exchanges[entry[2]]!.request;
        const shape = `${request.method} ${request.path.replace(/\/[0-9a-f]{32}/gu, "/:token").replace(/\/[A-Za-z0-9_-]+==/gu, "/:id")}`;
        if (!shapes.has(shape)) shapes.set(shape, entry);
      }
      for (const [name, file, index] of shapes.values()) {
        const { file: _file, ...options } = replayOptions(file, name);
        await replayFixtureExchange(file, index, options).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Rails and Node push in different orders across stores: both sides are compared sorted.
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        const { file: _file, ...options } = replayOptions(file, name);
        if (name.includes("hands-a-")) {
          // Whatever Node cannot prove goes to Rails whole, before its first write.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          expect(JSON.parse(handedBack[0]!.body || "{}")).toEqual(JSON.parse(request.body ?? "{}"));
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options);
        const [{ expected: want, actual }] = result.exchanges as [(typeof result.exchanges)[number]];
        const differences = compareExchange(mask(want) as typeof want, mask(actual) as typeof actual, {
          ...COMPARE,
          ignore: [...COMPARE.ignore, ...(want.response.status === 404 ? ["response.body"] : [])],
          ...(fixture.sessionCookie ? { sessionCookie: fixture.sessionCookie } : {}),
        });
        if (differences.length > 0) throw new Error(`${fixture.example}\n${formatDifferences(differences)}`);
        if (name.includes("send-to-kindle-queues-the-file")) {
          expect(mailJobs).toHaveLength(1);
          const wrapped = (mailJobs[0]!.args as { job_class: string; queue_name: string; arguments: unknown[] }[])[0]!;
          expect(wrapped).toMatchObject({ job_class: "MailDeliveryJob", queue_name: "critical" });
          expect(wrapped.arguments.slice(0, 2)).toEqual(["CustomerMailer", "send_to_kindle"]);
        } else {
          expect(mailJobs).toHaveLength(0);
        }
        // The confirmation cookie holds the token, whatever IV it was encrypted with.
        const cookie = actual.response.cookies?.confirmed_redirect;
        const recorded = want.response.cookies?.confirmed_redirect;
        expect(cookie === undefined).toBe(recorded === undefined);
        if (cookie)
          expect(readEncryptedCookie(secrets, "confirmed_redirect", String(cookie.value))).toBe(
            /^\/r\/([^/]+)/u.exec(want.request.path)?.[1] ??
              new URLSearchParams(String(want.request.body ?? "")).get("id"),
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
