import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/api/internal/agent_custom_html_previews_parity_spec.rb: the store agent's custom HTML preview. Each fixture is the last
// request of its example. A proposal the port hands back ("hands a ...") must reach the stand-in Rails untouched and write nothing.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const SPEC_DIR = "parity/fixtures/requests/api/internal/agent_custom_html_previews_parity_spec";
const ROUTE_FLAGS = "nextjs_internal_agent";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
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

const cases = existsSync(SPEC_DIR)
  ? readdirSync(SPEC_DIR)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/u, ""),
            path.join(SPEC_DIR, file),
            loadFixture(path.join(SPEC_DIR, file)).exchanges.length - 1,
          ] as const,
      )
  : [];

describe.skipIf(!url)("Api::Internal::AgentCustomHtmlPreviewsController", () => {
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
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    await new Promise((resolve) => rails.close(resolve));
    await closeAllRedis();
    await redis.quit();
    await es.close();
    await client.$disconnect();
    process.env = saved;
  });

  const options = () => ({
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
        await redisSeeder(redis).reset(entries);
        // User#eligible_for_store_agent? sums the seller's sales in the purchases index
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: COMPARE,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it(
    "compiles the handlers",
    async () => {
      const warmed = new Set<string>();
      for (const [, file, index] of cases) {
        const request = loadFixture(file).exchanges.at(index)!.request;
        const route = `${request.method} ${request.path.replace(/\/[^/]*(?==\/|$)/gu, "/:id").replace(/[?].*/u, "")}`;
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
        if (/hands-an?-/u.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options());
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(
            decodeURIComponent(request.path.split("?")[0]!),
          );
          if (request.body) expect(JSON.parse(handedBack[0]!.body)).toEqual(JSON.parse(request.body));
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, options()));
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
