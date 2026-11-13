import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import {
  ELASTICSEARCH_HOST,
  recreateIndex,
  reindexProducts,
  reindexPurchases,
  replayIndexName,
} from "../src/elasticsearch";
import { type Exchange, loadFixture, type RedisEntry } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays GET /v2/partner/products and /v2/partner/creators/top (spec/requests/api/v2/partner_search_parity_spec.rb) against `next dev`
// with the route flag on. Each fixture is one request with a bearer token, on the API host or under /api/v2. The products and purchases
// indices are rebuilt from the seeded rows before every request, under the name the server derives from ES_INDEX_SUFFIX, so the order
// and totals compared are Elasticsearch's answer to the port's own query over the port's own documents. A request the port hands back
// must reach the stand-in Rails with its body, before anything is written.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests/api/v2";
const SPEC_PATTERN = /^partner_search_parity_spec$/u;
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity-partner-search";
const ROUTE_FLAGS = "nextjs_api_v2_partner_search";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.link",
    // Next.js adds its RSC headers to Vary; checked below without them.
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "response.cookies._gumroad_app_session_test.value",
    "db.versions",
    "http",
  ],
};

const NEXT_VARY = /(?:rsc|next-router-state-tree|next-router-prefetch|next-router-segment-prefetch)(?:, )?/gu;
const withoutNextVary = (vary: unknown) => (typeof vary === "string" ? vary.replace(NEXT_VARY, "") : vary);
const HANDED_BACK = /back-to-rails|through-rails/u;

const dirs = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((dir) => SPEC_PATTERN.test(dir)) : [];
const cases = dirs.flatMap((spec) =>
  readdirSync(path.join(FIXTURES, spec))
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec}: ${file.replace(/\.json$/u, "")}`,
          path.join(FIXTURES, spec, file),
          loadFixture(path.join(FIXTURES, spec, file)).exchanges.length - 1,
        ] as const,
    ),
);

describe.skipIf(!url)("v2 partner product search", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
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

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  const options = () => ({
    sql,
    redis: {
      async reset(entries: Record<string, RedisEntry>, exchange?: Exchange, now?: Date) {
        await redisSeeder(redis).reset(entries);
        if (!exchange || !now) return;
        // A product document reads its sales from the purchases index.
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
        const products = { model: "Link", name: replayIndexName("products", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, products);
        await reindexProducts(es, products.name, sql);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    compare: COMPARE,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it(
    "compiles the handlers",
    async () => {
      await replayFixtureExchange(cases[0]![1], cases[0]![2], options()).catch(() => undefined);
      const warmed = new Set<string>();
      for (const [, file, index] of cases) {
        const request = loadFixture(file).exchanges.at(index)!.request;
        const route = `${request.method} ${request.path.replace(/[?].*/u, "").replace(/\/[A-Za-z0-9_=-]{12,}/gu, "/:id")}`;
        if (warmed.has(route)) continue;
        warmed.add(route);
        await replayFixtureExchange(file, index, options()).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        if (HANDED_BACK.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options());
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
            decodeURIComponent(request.path.split("?")[0]!),
          );
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options());
        assertParity(result);
        const { expected, actual } = result.exchanges[0]!;
        expect(withoutNextVary(actual.response.headers.vary)).toBe(expected.response.headers.vary);
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
