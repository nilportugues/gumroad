import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { compareExchange } from "../src/compare";
import { shiftLiteralInstants } from "../src/date-drift";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { bulkIndex, recreateIndex, reindexPurchases, replayIndexName, seededDocuments } from "../src/elasticsearch";
import { loadFixture, type CapturedExchange, type Exchange } from "../src/fixture";
import { maskGeneratedUids } from "../src/generated-uids";
import { startNextServer, type NextServer } from "../src/next-server";
import { fillFirstThrottle, rackAttackCounters } from "../src/rack-attack";
import { withoutRailsOnly } from "../src/rails-only";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the WS-17c request specs (spec/requests/api/v2/*_parity_spec.rb): API v2 users, pages, help articles, UTM links, emails, workflows,
// the MCP/Claude/ChatGPT/Muse aliases, the `.well-known` documents and the Notion unfurl. Each fixture is one token-authenticated request.
// A request Node hands back arrives at a stand-in for Rails, body and all; a fixture whose name has `hands-back` asserts that (and that Node wrote nothing).
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests/api/v2";
const WS17C_SPEC_DIRS = [
  "users",
  "utm_links",
  "marketing_actions",
  "emails",
  "workflows",
  "pages",
  "help_articles",
  "mcp",
  "mcp_register",
  "mcp_products",
  "mcp_publication",
  "mcp_product_writes",
  "mcp_discount_codes",
  "payouts_media",
  "sales_exports",
  "links",
  "licenses",
  "files",
  "media_destroy",
  "offer_codes_writes",
  "variants_writes",
  "product_enable",
  "upsells_writes",
  "resource_subscriptions_writes",
  "thumbnails",
  "product_builds_writes",
  "tax_forms_download",
  "product_create",
].map((name) => `${name}_parity_spec`);
// A new product's permalink is a random letter (Link#generate_unique_permalink): the one Rails drew is replaced by Node's wherever the
// recording shows it, in the rows and in the product's URLs, before the exchange is compared.
function reconcilePermalink(
  exchange: { expected: Exchange; actual: CapturedExchange; differences: unknown[] },
  compare: Parameters<typeof compareExchange>[2],
  sessionCookie?: string,
) {
  const drawn = (side: { db?: Record<string, { inserted?: Record<string, unknown>[] }> }) =>
    side.db?.links?.inserted?.[0]?.unique_permalink as string | undefined;
  const was = drawn(exchange.expected);
  const now = drawn(exchange.actual);
  if (was === undefined || now === undefined || was === now) return;
  const urlEnd = new RegExp(`(/l/)${was}(?![A-Za-z0-9_-])`, "gu");
  // An MCP tool result carries the payload as pretty-printed JSON text, where the permalink is a quoted value.
  const quoted = new RegExp(`("permalink": ")${was}(")`, "gu");
  const swap = (value: unknown): unknown => {
    if (typeof value === "string")
      return value === was ? now : value.replace(urlEnd, `$1${now}`).replace(quoted, `$1${now}$2`);
    if (Array.isArray(value)) return value.map(swap);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, swap(entry)]));
    return value;
  };
  exchange.expected = swap(exchange.expected) as Exchange;
  exchange.differences = compareExchange(exchange.expected, exchange.actual, { ...compare, sessionCookie });
}

const SPECS = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter(
      (dir) =>
        WS17C_SPEC_DIRS.includes(dir) && (process.env.WS17C_SPEC ? dir.startsWith(process.env.WS17C_SPEC) : true),
    )
  : [];
const ROUTE_FLAGS = [
  "user",
  "pages",
  "help_articles",
  "marketing_actions",
  "utm_links",
  "emails",
  "workflows",
  "mcp",
  "well_known",
  "notion_unfurl",
  "media",
  "payouts",
  "sales",
  "products",
  "licenses",
  "files",
  "offer_codes",
  "upsells",
  "resource_subscriptions",
  "tax",
]
  .map((name) => `nextjs_api_v2_${name}`)
  .join(",");
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// `lock: :until_executed`: the Rails run holds the lock the seller's factory took before the request, so a write of the seller never pushes it again.
const LOCKED_JOBS = new Set(["GenerateSubscribePreviewJob"]);
// A post attached to a product reindexes the product: the replay holds no document for it, so Node queues the fallback job Rails never needed.
const FALLBACK_JOBS = new Set(["SendToElasticsearchWorker"]);
// `lock: :until_executing`: Rails' test queue pushes every call, while Node (like production Sidekiq) drops a push whose lock is held, so
// the identical pushes Rails recorded collapse to one.
const UNIQUE_JOBS = new Set(["ReindexSellerOfferCodesJob"]);
const dedupeUnique = <T extends { class: string; args: unknown; queue?: string }>(jobs: T[]): T[] =>
  jobs.filter(
    (job, i) => !UNIQUE_JOBS.has(job.class) || jobs.findIndex((other) => jobKey(other) === jobKey(job)) === i,
  );

// An instant in 2099 is masked as whole hours from now, which moves by one with the minute of the hour. The requests below name the
// instants literally, so the replay compares the hours with a tolerance of one instead.
const VALIDITY_INSTANTS: [fragment: string, valid_at: string, expires_at: string][] = [
  ["-creates-a-code-with-a-validity-period", "2099-01-01T10:00:00Z", "2099-02-01T08:00:00Z"],
  ["-sets-a-validity-period-with-a-put", "2099-01-01T10:00:00Z", "2099-03-01T10:00:00Z"],
  ["-truncates-a-validity-period-with-a-fraction", "2099-01-01T10:59:59Z", "2099-02-01T08:00:00Z"],
];
const VALIDITY_FIELDS = [
  "response.json.offer_code.valid_at",
  "response.json.offer_code.expires_at",
  "db.offer_codes.inserted.*.valid_at",
  "db.offer_codes.inserted.*.expires_at",
  "db.offer_codes.updated.*.changes.valid_at",
  "db.offer_codes.updated.*.changes.expires_at",
];
const hoursFromNow = (token: unknown) => Number(/^<now([+-]\d+)h>$/u.exec(String(token))?.[1] ?? Number.NaN);

// The sending limit of an email counts the seller's audience in Elasticsearch: an empty audience_members index under the replay's own name.
async function resetAudienceIndex() {
  const es = new ElasticsearchClient({ node: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200" });
  const index = `audience_members${process.env.ES_INDEX_SUFFIX ?? ""}`;
  await es.indices.delete({ index }, { ignore: [404] });
  await es.indices.create({ index, body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0 } } } });
  // eligible_to_send_emails? sums the seller's sales in the purchases index.
  await recreateIndex(es, { model: "Purchase", name: replayIndexName("purchases", process.env.ES_INDEX_SUFFIX ?? "") });
  await es.close();
}

// These requests carry a literal instant or date (a page key, an `after` timestamp, a report range) while the rows are
// seeded relative to the replay's clock, so drifting the response cannot line them up. The seeding clock is pinned to
// the instant of the recording instead (the middle of what the hour-rounded `<now-Nh>` tokens allow). Only the seed
// resolves against it: the server's cookie expiries and the rest of the response stay on the replay's clock.
const PINNED_CLOCKS: [fragment: string, recordedAt: string][] = [
  ["serves-the-page-after-a-page-key", "2026-11-11T01:01:59Z"],
  ["-sale-trigger-after-a-time", "2026-11-10T21:00:00Z"],
  ["-sale-trigger-before-a-time", "2026-11-10T21:00:00Z"],
  ["-reports-sales-totals-by-day", "2026-11-12T05:00:00Z"],
  ["-reports-sales-totals-by-week", "2026-11-12T05:00:00Z"],
  ["-reports-sales-totals-by-month", "2026-11-12T05:00:00Z"],
  ["-sales-totals-by-country-reports-sales-totals-by-country", "2026-11-12T05:00:00Z"],
  ["-list-sales-", "2026-11-12T05:00:00Z"],
  ["-list-products-", "2026-11-12T06:00:00Z"],
  ["-get-analytics-", "2026-11-12T11:00:00Z"],
  ["-get-subscriptions-", "2026-11-12T11:00:00Z"],
  ["-reports-sales-totals-", "2026-11-10T16:45:00Z"],
  ["-reports-the-spend-of-a-buyer-in-a-date-range", "2026-11-10T16:45:00Z"],
];

// The recording masked these requests' literal 2099 instants as hours from its own clock (all at 2026-11-13T10:00Z); the request
// is moved by the whole hours since then so the port's output keeps that distance from the replay's clock.
const RECORDED_INSTANTS: [fragment: string, recordedAt: string][] = [
  ["-create-discount-code-sets-the-validity-period", "2026-11-13T10:00:00Z"],
  ["-create-discount-code-starts-a-code-that-only-has-an-end-date-now", "2026-11-13T10:00:00Z"],
  ["-update-discount-code-sets-an-end-date-and-starts-the-code-from-its-creation", "2026-11-13T10:00:00Z"],
  ["-update-discount-code-sets-both-ends-of-the-validity-period", "2026-11-13T10:00:00Z"],
];

// A file attached to a new product must exist in the bucket. The recording uploaded its objects first; the replay uploads the ones the request
// names, except an object named "missing..." (the request that attaches a file never uploaded).
const SPEC_BUCKET = "gumroad-specs";
async function uploadNamedFiles(exchange: Exchange) {
  const urls: string[] = [];
  try {
    const files = (JSON.parse(exchange.request.body ?? "") as { files?: unknown }).files;
    if (Array.isArray(files))
      for (const file of files as { url?: unknown }[]) if (typeof file?.url === "string") urls.push(file.url);
  } catch {
    // not a JSON body
  }
  for (const row of exchange.seed?.tables?.product_files?.rows ?? [])
    if (typeof row.url === "string") urls.push(row.url);
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    forcePathStyle: true,
    credentials: {
      accessKeyId: testEnv("AWS_ACCESS_KEY_ID") ?? "",
      secretAccessKey: testEnv("AWS_SECRET_ACCESS_KEY") ?? "",
    },
  });
  for (const url of urls) {
    if (!url.startsWith(`http://localhost:9010/${SPEC_BUCKET}/`)) continue;
    const key = new URL(url).pathname.replace(new RegExp(`^/${SPEC_BUCKET}/`, "u"), "");
    if (key.split("/").at(-1)!.startsWith("missing")) continue;
    await s3.send(new PutObjectCommand({ Bucket: SPEC_BUCKET, Key: key, Body: "uploaded bytes" }));
  }
  s3.destroy();
}

const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
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
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
          jobs.push({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          });
        }
      }
      // A delayed job that still runs in Ruby goes to Sidekiq's `schedule` set.
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      return dedupeUnique(
        jobs
          .filter((job) => !LOCKED_JOBS.has(job.class) && !FALLBACK_JOBS.has(job.class))
          .sort((a, b) => jobKey(a).localeCompare(jobKey(b))),
      );
    },
  };
}

const COMPARE = {
  ignore: [
    // The cursor holds the last payout's created_at, seeded from a "now minus N hours" token that moves with the replay's clock.
    "response.json.next_page_key",
    "response.json.next_page_url",
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // PaperTrail is off in the Rails specs; the goldens of each write pin the versions Node writes.
    "db.versions",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.users.updated.*.changes.updated_at",
    "db.installments.updated.*.changes.updated_at",
    "db.installment_rules.updated.*.changes.updated_at",
    "db.offer_codes.updated.*.changes.updated_at",
    "db.base_variants.updated.*.changes.updated_at",
    "db.links.updated.*.changes.updated_at",
    // A presigned link carries the second it was signed in; the test compares everything else about it.
    "response.json.product.files.*.url",
    "db.licenses.updated.*.changes.updated_at",
    // The first request to a route compiles it, and a delete stamps the replay's clock plus that compile.
    "db.installments.updated.*.changes.deleted_at",
    "db.base_variants.updated.*.changes.deleted_at",
    "db.product_variant_deletion_audits.inserted.*.created_at",
    // An instant in 2099 is masked as whole hours from now, so the minute of the hour moves it by one.
    "response.json.email.scheduled_at",
    "db.installment_rules.inserted.*.to_be_published_at",
    "jobs.*.at",
    "http",
    // Rails renders its debug exception page for a 404 in the test environment.
    "response.body",
  ],
};

const allCases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec.replace(/_parity_spec$/u, "")}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

// Rails serves the throttled routes whole; rack-attack-routes.replay.test.ts replays those.
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);

describe.skipIf(!url)("WS-17c API v2 parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetAudienceIndex();
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
      OPENAI_APPS_CHALLENGE_TOKEN: "challenge-token-123",
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  // The tool descriptions of tools/list carry fixed example dates, which must not move with the days since the recording.
  let driftDates = true;
  let seedClock: Date | undefined;
  let instantsRecordedAt: Date | undefined;
  // Runs once the seeder has reset Redis, ahead of the request under test.
  let afterRedisReset: (() => Promise<void>) | undefined;
  const replayOptions = (random: string[] = []) => ({
    driftDates,
    ...(seedClock ? { seedClock } : {}),
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
        await redisSeeder(redis).reset(entries);
        await afterRedisReset?.();
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => {
      const rewritten = reencryptCookies(request, loaded, SECRET_KEY_BASE, now);
      return instantsRecordedAt && rewritten.body !== undefined
        ? { ...rewritten, body: shiftLiteralInstants(rewritten.body, instantsRecordedAt, now) }
        : rewritten;
    },
    compare: { ignore: [...COMPARE.ignore, ...random] },
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request to a route compiles it (10 s or more), which would age the seeded timestamps past the replayer's tolerance
  // (<now+10s> against <now>). Each route is replayed once, unchecked, ahead of its first fixture, so a filtered run is as steady as a full one.
  const warmed = new Set<string>();
  async function warmRoute(file: string, index: number) {
    const { method, path: requestPath } = loadFixture(file).exchanges[index]!.request;
    const route = `${method} ${requestPath.replace(/[?].*/u, "").replace(/\/[^/]*(?:==|[a-z]\d)[^/]*(?=\/|$)/gu, "/:id")}`;
    if (warmed.has(route)) return;
    warmed.add(route);
    seedClock = undefined;
    instantsRecordedAt = undefined;
    afterRedisReset = undefined;
    await uploadNamedFiles(loadFixture(file).exchanges[index]!);
    await replayFixtureExchange(loadFixture(file), index, replayOptions()).catch(() => undefined);
    handedBack.length = 0;
  }

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        await warmRoute(file, index);
        seedClock = undefined;
        afterRedisReset = undefined;
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        await uploadNamedFiles(expected);
        expected.jobs = [...(expected.jobs ?? [])]
          .filter((job) => !LOCKED_JOBS.has(job.class) && !FALLBACK_JOBS.has(job.class))
          .sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        expected.jobs = dedupeUnique(expected.jobs);
        // successful_sales_count, total_usd_cents and get_analytics search the purchases and page view indices, which Rails
        // filled as the sales were made and the views recorded.
        if (
          name.includes("-reports-the-sales-figures-") ||
          name.includes("-get-analytics-") ||
          name.includes("-with-the-churn-breakdown-")
        ) {
          afterRedisReset = async () => {
            const es = new ElasticsearchClient({ node: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200" });
            const suffix = process.env.ES_INDEX_SUFFIX ?? "";
            const purchases = { model: "Purchase", name: replayIndexName("purchases", suffix) } as const;
            await recreateIndex(es, purchases);
            await reindexPurchases(es, purchases.name, sql);
            const views = { model: "ProductPageView", name: replayIndexName("product_page_views", suffix) } as const;
            await recreateIndex(es, views);
            await bulkIndex(
              es,
              views.name,
              seededDocuments(expected, "ProductPageView", seedClock ?? new Date()).map((body) => ({ body })),
            );
            await es.close();
          };
        }
        if (name.includes("hands-back") || /-hands-an?-/u.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions());
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: expected.request.method, url: expected.request.path });
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          // Rails counts the request it receives: what Node counted ahead of the hand-back is taken back.
          expect(Object.values(await rackAttackCounters(redis)).every((count) => count === 0)).toBe(true);
          return;
        }
        // The recording filled the throttle by calling Rack::Attack in a loop; the replay puts the same counter at its limit.
        const tripsThrottle = name.includes("-past-the-per-ip-limit");
        if (tripsThrottle) handedBack.length = 0;
        if (tripsThrottle) afterRedisReset = async () => void (await fillFirstThrottle(redis, expected.request));
        const validity = VALIDITY_INSTANTS.find(([fragment]) => name.includes(fragment));
        const pinned = PINNED_CLOCKS.find(([fragment]) => name.includes(fragment));
        driftDates = !pinned && !name.includes("answers-a-tools-list-call");
        seedClock = pinned ? new Date(pinned[1]) : undefined;
        const recordedInstants = RECORDED_INSTANTS.find(([fragment]) => name.includes(fragment));
        instantsRecordedAt = recordedInstants ? new Date(recordedInstants[1]) : undefined;
        const paginates = name.includes("paginates-with-a-page-key");
        // License#generate_serial is random: both sides mint a key of the same shape, and the response carries the one saved.
        const rotates = name.includes("-rotate-gives-");
        // The client id and secret are SecureRandom.urlsafe_base64(32): the replay holds both to that shape and to each other.
        const registersClient = Object.keys(expected.db ?? {}).includes("oauth_applications");
        if (registersClient) handedBack.length = 0;
        const createsUtmLink =
          (Object.keys(expected.db ?? {}).includes("utm_links") && name.includes("-creates-")) ||
          name.includes("-ignores-a-utm-parameter");
        // meta.timestamp is created_at.to_i: the replay seeds the row relative to its own clock, so it only compares in kind.
        const iftttSales = name.includes("-sale-trigger");
        if (iftttSales) handedBack.length = 0;
        // SecureRandom.alphanumeric(8) permalinks and the guid cookie Rails mints for a request without one.
        const options = replayOptions(
          validity
            ? VALIDITY_FIELDS
            : registersClient
              ? [
                  "response.json.client_id",
                  "response.json.client_secret",
                  "response.json.client_id_issued_at",
                  "db.oauth_applications.inserted.*.uid",
                  "db.oauth_applications.inserted.*.secret",
                ]
              : rotates
                ? ["response.json.purchase.license_key", "db.licenses.updated.*.changes.serial"]
                : createsUtmLink
                  ? [
                      "response.json.utm_link.short_url",
                      "db.utm_links.inserted.*.permalink",
                      "db.utm_links.inserted.*.browser_guid",
                    ]
                  : paginates
                    ? ["response.json.next_page_key", "response.json.next_page_url"]
                    : iftttSales
                      ? ["response.json.data.*.meta.timestamp"]
                      : tripsThrottle
                        ? ["response.headers.retry-after"]
                        : [],
        );
        const result = await replayFixtureExchange(fixture, index, options);
        reconcilePermalink(result.exchanges[0]!, options.compare, fixture.sessionCookie);
        maskGeneratedUids(result.exchanges[0]!, {
          ...options.compare,
          ...(fixture.sessionCookie ? { sessionCookie: fixture.sessionCookie } : {}),
        });
        assertParity(result);
        if ((expected.response.json as { product?: { files?: unknown } } | undefined)?.product?.files !== undefined) {
          const signed = (result.exchanges[0]!.actual.response.json as { product?: { files?: { url: string }[] } })
            .product?.files;
          const wanted = (expected.response.json as { product?: { files?: { url: string }[] } }).product?.files;
          const withoutSignature = (link: string | null) =>
            link?.replace(/X-Amz-Date=[^&]*|X-Amz-Signature=[^&]*|%2F\d{8}%2F/gu, "");
          expect((signed ?? []).map((file) => withoutSignature(file.url))).toEqual(
            (wanted ?? []).map((file) => withoutSignature(file.url)),
          );
        }
        if (validity) {
          const offerCode = (result.exchanges[0]!.actual.response.json as { offer_code: Record<string, unknown> })
            .offer_code;
          for (const [key, iso] of [
            ["valid_at", validity[1]],
            ["expires_at", validity[2]],
          ] as const) {
            const hours = (Date.parse(iso) - Date.now()) / 3_600_000;
            expect(Math.abs(hoursFromNow(offerCode[key]) - hours)).toBeLessThanOrEqual(1);
          }
        }
        if (tripsThrottle) {
          const retryAfter = Number(result.exchanges[0]!.actual.response.headers["retry-after"]);
          expect(retryAfter).toBeGreaterThan(0);
          expect(retryAfter).toBeLessThanOrEqual(60);
          expect(handedBack).toHaveLength(0);
        }
        if (name.includes("-counts-a-refusal")) {
          // Every tier of `oauth_dynamic_registration/ip` counted the request once, under the key Rack::Attack uses.
          const counters = await rackAttackCounters(redis);
          expect(
            Object.keys(counters)
              .map((key) => key.replace(/^rack::attack:\d+:/u, ""))
              .sort(),
          ).toEqual(
            ["", "/2", "/3", "/4", "/5"].map((tier) => `oauth_dynamic_registration/ip${tier}:203.0.113.55`).sort(),
          );
          expect(Object.values(counters)).toEqual([1, 1, 1, 1, 1]);
        }
        if (registersClient) {
          expect(handedBack).toHaveLength(0);
          const actual = result.exchanges[0]!.actual;
          const body = actual.response.json as Record<string, unknown>;
          const row = (actual.db as { oauth_applications: { inserted: Record<string, unknown>[] } }).oauth_applications
            .inserted[0]!;
          const token = /^[A-Za-z0-9_-]{43}$/u;
          expect(row.uid).toMatch(token);
          expect(row.secret).toMatch(token);
          expect(body.client_id).toBe(row.uid);
          if (row.confidential === 1) expect(body.client_secret).toBe(row.secret);
          else expect(body).not.toHaveProperty("client_secret");
          expect(Math.abs(Number(body.client_id_issued_at) - Date.now() / 1000)).toBeLessThan(60);
        }
        if (iftttSales) {
          expect(handedBack).toHaveLength(0);
          const rows = (result.exchanges[0]!.actual.response.json as { data: { meta: { timestamp: number } }[] }).data;
          const wanted = (expected.response.json as { data: unknown[] }).data;
          expect(rows).toHaveLength(wanted.length);
          for (const row of rows) expect(Number.isInteger(row.meta.timestamp)).toBe(true);
          const times = rows.map((row) => row.meta.timestamp);
          expect(times).toEqual([...times].sort((a, b) => (name.includes("oldest-first") ? a - b : b - a)));
        }
        if (paginates) {
          // The key is the created_at of the tenth email, which the factory stamped relative to the recording's clock.
          const body = result.exchanges[0]!.actual.response.json as { next_page_key: string; next_page_url: string };
          expect(body.next_page_key).toMatch(/^\d{20}-\d+$/u);
          expect(body.next_page_url).toBe(`/v2/emails?page_key=${body.next_page_key}&type=draft`);
        }
        if (rotates) {
          const serial = (
            result.exchanges[0]!.actual.db as { licenses: { updated: { changes: { serial: [string, string] } }[] } }
          ).licenses.updated[0]!.changes.serial[1];
          expect(serial).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/u);
          const purchase = (result.exchanges[0]!.actual.response.json as { purchase?: { license_key: string } })
            .purchase;
          if (purchase) expect(purchase.license_key).toBe(serial);
        }
        if (createsUtmLink) {
          const inserted = (
            result.exchanges[0]!.actual.db as { utm_links: { inserted: { permalink: string; browser_guid: string }[] } }
          ).utm_links.inserted[0]!;
          expect(inserted.permalink).toMatch(/^[a-z0-9]{8}$/u);
          expect(inserted.browser_guid).toMatch(/^[0-9a-f-]{36}$/u);
          expect(
            (result.exchanges[0]!.actual.response.json as { utm_link: { short_url: string } }).utm_link.short_url,
          ).toMatch(new RegExp(`/u/${inserted.permalink}$`, "u"));
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
