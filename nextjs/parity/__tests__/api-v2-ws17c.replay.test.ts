import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { recreateIndex, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the WS-17c request specs (spec/requests/api/v2/*_parity_spec.rb): API v2 users, pages, help articles, UTM links, emails, workflows,
// the MCP/Claude/ChatGPT/Muse aliases, the `.well-known` documents and the Notion unfurl. Each fixture is one token-authenticated request.
// A request Node hands back arrives at a stand-in for Rails, body and all; a fixture whose name has `hands-back` asserts that (and that Node wrote nothing).
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests/api/v2";
const WS17C_SPEC_DIRS = ["users", "utm_links", "emails", "workflows", "pages", "help_articles", "mcp"].map((name) => `${name}_parity_spec`);
const SPECS = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((dir) => WS17C_SPEC_DIRS.includes(dir) && (process.env.WS17C_SPEC ? dir.startsWith(process.env.WS17C_SPEC) : true)) : [];
const ROUTE_FLAGS = ["user", "pages", "help_articles", "marketing_actions", "utm_links", "emails", "workflows", "mcp", "well_known", "notion_unfurl"].map((name) => `nextjs_api_v2_${name}`).join(",");
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

// `lock: :until_executed`: the Rails run holds the lock the seller's factory took before the request, so a write of the seller never pushes it again.
const LOCKED_JOBS = new Set(["GenerateSubscribePreviewJob"]);
// A post attached to a product reindexes the product: the replay holds no document for it, so Node queues the fallback job Rails never needed.
const FALLBACK_JOBS = new Set(["SendToElasticsearchWorker"]);

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

const jobKey = (job: { class: string; args: unknown; queue?: string }) => `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as { class: string; args: unknown[]; queue: string; at?: number };
        jobs.push({ class: item.class, args: item.args, queue: item.queue, ...(item.at === undefined ? {} : { at: item.at }) });
      }
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
          jobs.push({ class: item.class, args: item.args, queue: item.queue, ...(item.at === undefined ? {} : { at: item.at }) });
        }
      }
      return jobs.filter((job) => !LOCKED_JOBS.has(job.class) && !FALLBACK_JOBS.has(job.class)).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
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
    // The first request to a route compiles it, and a delete stamps the replay's clock plus that compile.
    "db.installments.updated.*.changes.deleted_at",
    // An instant in 2099 is masked as whole hours from now, so the minute of the hour moves it by one.
    "response.json.email.scheduled_at",
    "db.installment_rules.inserted.*.to_be_published_at",
    "jobs.*.at",
    "http",
    // Rails renders its debug exception page for a 404 in the test environment.
    "response.body",
  ],
};

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec.replace(/_parity_spec$/, "")}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

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
        handedBack.push({ method: request.method ?? "", url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1] ?? "",
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

  const replayOptions = (random: string[] = []) => ({
    sql,
    redis: redisSeeder(redis),
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (request: Parameters<typeof reencryptCookies>[0], loaded: Parameters<typeof reencryptCookies>[1], now: Date) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: { ignore: [...COMPARE.ignore, ...random] },
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].filter((job) => !LOCKED_JOBS.has(job.class) && !FALLBACK_JOBS.has(job.class)).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        if (name.includes("hands-back")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions());
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: expected.request.method, url: expected.request.path });
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const paginates = name.includes("paginates-with-a-page-key");
        const createsUtmLink = Object.keys(expected.db ?? {}).includes("utm_links") && name.includes("-creates-") || name.includes("-ignores-a-utm-parameter");
        // SecureRandom.alphanumeric(8) permalinks and the guid cookie Rails mints for a request without one.
        const result = await replayFixtureExchange(fixture, index, replayOptions(createsUtmLink ? ["response.json.utm_link.short_url", "db.utm_links.inserted.*.permalink", "db.utm_links.inserted.*.browser_guid"] : paginates ? ["response.json.next_page_key", "response.json.next_page_url"] : []));
        assertParity(result);
        if (paginates) {
          // The key is the created_at of the tenth email, which the factory stamped relative to the recording's clock.
          const body = result.exchanges[0]!.actual.response.json as { next_page_key: string; next_page_url: string };
          expect(body.next_page_key).toMatch(/^\d{20}-\d+$/);
          expect(body.next_page_url).toBe(`/v2/emails?page_key=${body.next_page_key}&type=draft`);
        }
        if (createsUtmLink) {
          const inserted = (result.exchanges[0]!.actual.db as { utm_links: { inserted: { permalink: string; browser_guid: string }[] } }).utm_links.inserted[0]!;
          expect(inserted.permalink).toMatch(/^[a-z0-9]{8}$/);
          expect(inserted.browser_guid).toMatch(/^[0-9a-f-]{36}$/);
          expect((result.exchanges[0]!.actual.response.json as { utm_link: { short_url: string } }).utm_link.short_url).toMatch(new RegExp(`/u/${inserted.permalink}$`));
        }
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
