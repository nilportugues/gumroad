import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { bulkIndex, ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName, seededDocuments } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/api/mobile/mobile_analytics_parity_spec.rb: the mobile analytics endpoints (by_date, by_state, by_referral, revenue_totals).
// The spec froze the clock at PARITY_NOW, so the replay moves both its own clock and the server's to that instant. The indices the endpoints
// search are rebuilt before every exchange, under the names the server derives from ES_INDEX_SUFFIX.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests/api/mobile";
const SPECS = ["mobile_analytics_parity_spec"];
const PARITY_NOW = Date.UTC(2026, 10, 2, 15, 0, 0);
const ROUTE_FLAGS = "nextjs_mobile_analytics";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-ws17f";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];
const obfuscateKey = testEnv("OBFUSCATE_IDS_CIPHER_KEY");
const stripeKey = testEnv("STRIPE_PUBLIC_KEY_TEST");
const dynamoPrefix = testEnv("DYNAMODB_TABLE_PREFIX");
const awsAccessKeyId = testEnv("AWS_ACCESS_KEY_ID");
const awsSecretAccessKey = testEnv("AWS_SECRET_ACCESS_KEY");

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "http",
    "response.headers.link",
    // Next.js adds its RSC headers to Vary; checked below without them.
    "response.headers.vary",
    // Stamped when the (slow, dev-compiled) request writes them; the keys and documents are compared.
    "db.computed_sales_analytics_days.inserted.*.created_at",
    "db.computed_sales_analytics_days.inserted.*.updated_at",
  ],
};

const NEXT_VARY = /(?:rsc|next-router-state-tree|next-router-prefetch|next-router-segment-prefetch)(?:, )?/g;
const withoutNextVary = (vary: unknown) => (typeof vary === "string" ? vary.replace(NEXT_VARY, "") : vary);

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("mobile analytics parity", () => {
  let rails: Server;
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    // Stands in for the Rails app: a request the port hands back lands here and fails the comparison.
    rails = createServer((_request, response) => void response.writeHead(200, { "content-type": "text/plain" }).end("rails answered"));
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsOrigin = `http://127.0.0.1:${(rails.address() as { port: number }).port}`;
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    const offset = PARITY_NOW - Date.now();
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(offset),
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      MOBILE_TOKEN: testEnv("MOBILE_TOKEN") ?? "",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: railsOrigin,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(dynamoPrefix ? { DYNAMODB_TABLE_PREFIX: dynamoPrefix } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(awsAccessKeyId ? { AWS_ACCESS_KEY_ID: awsAccessKeyId } : {}),
      ...(awsSecretAccessKey ? { AWS_SECRET_ACCESS_KEY: awsSecretAccessKey } : {}),
    });
    // Only Date moves, and it keeps running from the frozen instant.
    vi.useFakeTimers({ now: PARITY_NOW, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    vi.useRealTimers();
    await server?.stop();
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await new Promise((resolve) => rails?.close(resolve));
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  const replay = (file: string, index: number) =>
    replayFixtureExchange(file, index, {
      sql,
      redis: {
        async reset(entries, exchange, now) {
          await redisSeeder(redis).reset(entries);
          if (!exchange || !now) return;
          const views = { model: "ProductPageView", name: replayIndexName("product_page_views", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, views);
          await bulkIndex(es, views.name, seededDocuments(exchange, "ProductPageView", now).map((body) => ({ body })));
          const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, purchases);
          await reindexPurchases(es, purchases.name, sql);
        },
      },
      transport: httpTransport(server.baseUrl),
      interceptHttp: false,
      // The clock is pinned to the recording, so nothing ages.
      driftDates: false,
      compare: COMPARE,
    });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it("warms up the routes", async () => {
    const warmed = new Set<string>();
    for (const [, file, index] of cases) {
      const route = loadFixture(file).exchanges.at(index)!.request.path.replace(/[?].*/, "");
      if (warmed.has(route)) continue;
      warmed.add(route);
      await replay(file, index).catch(() => undefined);
    }
  }, FIRST_COMPILE_TIMEOUT_MS * 3);

  it.each(cases)(
    "%s",
    async (_name, file, index) => {
      try {
        const result = await replay(file, index);
        assertParity(result);
        const { expected, actual } = result.exchanges[0]!;
        expect(withoutNextVary(actual.response.headers.vary)).toBe(expected.response.headers.vary);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
