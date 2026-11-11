import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";
import { AudienceMemberRecord } from "@/server/search/documents/simple";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { bulkIndex, ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/internal_api_parity_spec.rb and internal_agent_parity_spec.rb: the Api::Internal endpoints on the API host (minimum mobile version, home page
// numbers, the GRMC webhook) and the dashboard's JSON endpoints (audience and recipient counts, clicked URLs, existing product files,
// review video approvals, the Agent chat reads). Each fixture is the last request of its example. A request the port hands back ("hands a ...") must reach
// the stand-in Rails untouched. The audience_members index is rebuilt from the seeded rows; the email engagement table (DynamoDB) is
// seeded per case, because the recorder cannot see it.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["internal_api_parity_spec", "internal_agent_parity_spec", "internal_sends_parity_spec"];
const ROUTE_FLAGS =
  "nextjs_internal_api_host,nextjs_internal_installments,nextjs_internal_product_files,nextjs_internal_review_videos,nextjs_internal_agent,nextjs_internal_product_posts,nextjs_internal_customer_emails,nextjs_internal_receipt_previews";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012";
const DYNAMODB_TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX ?? "ws17d_";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    "http",
  ],
};

const HOME_PAGE_NUMBERS = "/internal/home_page_numbers";
const HOME_PAGE_CASE = "groups-the-stored-payout-by-thousands";

// The clicks each case finds in the engagement table: [url, click_count].
const CLICKS: Record<string, [string, number][]> = {
  "lists-the-clicked-urls-by-count": [
    ["https://example.com/a", 2],
    ["http://www.example.com/b", 5],
    ["view_attachments_url", 3],
  ],
  "sums-stored-urls-that-display-the-same": [
    ["https://example.com/a", 2],
    ["http://www.example.com/a", 1],
  ],
  "lets-an-accountant-read-the-clicks": [["https://example.com/a", 2]],
  "hands-a-list-of-urls-with-equal-counts-to-rails": [
    ["https://example.com/a", 2],
    ["https://example.com/b", 2],
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
          file.replace(/\.json$/, ""),
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

// Jobs Node enqueues sit in Sidekiq's own lists (the Ruby job) or BullMQ (a ported one).
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
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
          jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      return jobs;
    },
  };
}

async function dynamo(operation: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(DYNAMODB_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `DynamoDB_20120810.${operation}`,
      authorization:
        "AWS4-HMAC-SHA256 Credential=local/20250101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=local",
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as Record<string, unknown>;
}

// The partition of `installmentId` holds exactly `clicks` (URL# items), as the spec's put_item calls left it.
async function seedClicks(installmentId: number, clicks: [string, number][]): Promise<void> {
  const TableName = `${DYNAMODB_TABLE_PREFIX}email_engagement`;
  const existing = await dynamo("Query", {
    TableName,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": { S: String(installmentId) } },
  });
  for (const item of (existing.Items as Record<string, { S: string }>[] | undefined) ?? [])
    await dynamo("DeleteItem", { TableName, Key: { pk: item.pk, sk: item.sk } });
  for (const [clickUrl, count] of clicks) {
    const sk = `URL#${createHash("sha256").update(clickUrl).digest("hex")}`;
    await dynamo("PutItem", {
      TableName,
      Item: {
        pk: { S: String(installmentId) },
        sk: { S: sk },
        click_url: { S: clickUrl },
        click_count: { N: String(count) },
      },
    });
  }
}

describe.skipIf(!url)("Api::Internal endpoints", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  let currentCase = "";
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      GRMC_WEBHOOK_SECRET: testEnv("GRMC_WEBHOOK_SECRET") ?? "",
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT,
      DYNAMODB_TABLE_PREFIX,
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  // Rails' test environment answers a missing record with its exception debug page; production renders the JSON of PublicExceptions, which
  // is what the port writes. The recorder keeps the page as a placeholder, so the format it was served in is not a contract.
  const compareFor = (file: string, index: number) => {
    const body = loadFixture(file).exchanges.at(index)!.response.body;
    return typeof body === "string" && body.startsWith("<rails exception debug page")
      ? {
          ignore: [
            ...COMPARE.ignore,
            "response.headers.content-type",
            "response.json",
            "response.body",
            "response.cookies",
          ],
        }
      : COMPARE;
  };

  const options = (compare: typeof COMPARE = COMPARE) => ({
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
        await redisSeeder(redis).reset(entries);
        const members = replayIndexName("audience_members", ES_INDEX_SUFFIX);
        await recreateIndex(es, { model: "AudienceMember", name: members });
        const documents: { id: string; body: Record<string, unknown> }[] = [];
        for (const { id } of await sql.query("SELECT id FROM audience_members ORDER BY id")) {
          const record = await AudienceMemberRecord.find(id);
          if (record) documents.push({ id: String(id), body: await record.asIndexedJson() });
        }
        await bulkIndex(es, members, documents);
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
        const [installment] = await sql.query("SELECT id FROM installments ORDER BY id LIMIT 1");
        const clicks = Object.entries(CLICKS).find(([name]) => currentCase.endsWith(name))?.[1] ?? [];
        if (installment) await seedClicks(Number(installment.id), clicks);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    // The webhook's timestamp is part of the header, not of the signed body: the recorded one is long past the minute Rails allows.
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => {
      const rewritten = reencryptCookies(request, loaded, SECRET_KEY_BASE, now);
      const signature = rewritten.headers["grmc-signature"];
      const stale = currentCase.includes("stale-timestamp");
      return typeof signature === "string" && !stale
        ? {
            ...rewritten,
            headers: { ...rewritten.headers, "grmc-signature": signature.replace(/^t=\d+/, `t=${Date.now()}`) },
          }
        : rewritten;
    },
    compare,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it(
    "compiles the handlers",
    async () => {
      const warmed = new Set<string>();
      for (const [name, file, index] of cases) {
        const request = loadFixture(file).exchanges.at(index)!.request;
        // Rails.cache is the server's own memory: a replay of the home page numbers would fill it for the cases after it.
        if (request.path === HOME_PAGE_NUMBERS) continue;
        const route = `${request.method} ${request.path.replace(/\/[^/]*(?==\/|$)/g, "/:id").replace(/[?].*/, "")}`;
        if (warmed.has(route)) continue;
        warmed.add(route);
        currentCase = name;
        await replayFixtureExchange(file, index, options()).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  // The server caches the figure for a day, as Rails does: the first case replayed is the one that finds the cache empty. The rest of the
  // figures are pinned by number-with-delimiter.golden.json.
  it.each(cases)(
    "%s",
    async (name, file, index) => {
      if (name.includes("home-page-numbers") && !name.includes(HOME_PAGE_CASE)) return;
      currentCase = name;
      try {
        const fixture = loadFixture(file);
        if (name.includes("hands-a-")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options());
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
            decodeURIComponent(request.path.split("?")[0]!),
          );
          if (request.body) expect(JSON.parse(handedBack[0]!.body)).toEqual(JSON.parse(request.body));
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, options(compareFor(file, index))));
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
