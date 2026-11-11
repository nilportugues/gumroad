import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexProducts, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { withoutRailsOnly } from "../src/rails-only";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the products sections of a seller's public profile: spec/requests/storefront_profile_products_parity_spec.rb.
// The products index the sections search is rebuilt from the seeded rows before every exchange, under the name the
// server derives from ES_INDEX_SUFFIX. Examples named "hands back" are the ones the port leaves to Rails: they are
// proven by the request reaching a stand-in for it.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/storefront_profile_products_parity_spec";
const ROUTE_FLAGS = "nextjs_storefront_profile";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const RAILS_ANSWER = "rails answered";
const HANDED_BACK = /hands-back/u;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.versions",
    "db.users.updated.*.changes.updated_at",
    "response.headers.link",
    "response.headers.vary",
    // The Elasticsearch calls happen in the server process; search-products.test.ts pins their bodies.
    "http",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
  ],
};

const allCases = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => [file.replace(/\.json$/u, ""), path.join(FIXTURE_DIR, file), loadFixture(path.join(FIXTURE_DIR, file)).exchanges.length - 1] as const);

// Rails serves the throttled routes whole; rack-attack-routes.replay.test.ts replays those.
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);

describe.skipIf(!url)("storefront profile products parity", () => {
  let rails: Server;
  const railsRequests: { method?: string; url?: string }[] = [];
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((request, response) => {
      railsRequests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "text/plain" }).end(RAILS_ANSWER);
    });
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
    const optional = (name: string) => (testEnv(name) ? { [name]: testEnv(name)! } : {});
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...optional("RECAPTCHA_MONEY_SITE_KEY"),
      ...optional("STRIPE_PUBLIC_KEY_TEST"),
      ...optional("DYNAMODB_TABLE_PREFIX"),
      ...optional("AWS_ACCESS_KEY_ID"),
      ...optional("AWS_SECRET_ACCESS_KEY"),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      NEXTJS_ASSUME_SIGNED_OUT: "1",
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: railsOrigin,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await new Promise((resolve) => rails?.close(resolve));
    await client?.$disconnect();
    process.env = saved;
  });

  const replay = (file: string, index: number) =>
    replayFixtureExchange(file, index, {
      sql,
      redis: {
        async reset(entries, exchange) {
          await redisSeeder(redis).reset(entries);
          if (!exchange) return;
          const products = { model: "Link", name: replayIndexName("products", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, products);
          await reindexProducts(es, products.name, sql);
        },
      },
      transport: httpTransport(server.baseUrl),
      interceptHttp: false,
      rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
      compare: COMPARE,
    });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it("warms up the routes", async () => {
    const [first] = cases.filter(([name]) => !HANDED_BACK.test(name));
    if (first) await replay(first[1], first[2]).catch(() => undefined);
  }, FIRST_COMPILE_TIMEOUT_MS * 2);

  it("finds the fixtures", () => {
    expect(allCases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      railsRequests.length = 0;
      try {
        const result = await replay(file, index);
        if (HANDED_BACK.test(name)) {
          expect(railsRequests.at(-1)?.method).toBe("GET");
          expect(result.exchanges[0]!.actual.response.body).toBe(RAILS_ANSWER);
        } else {
          assertParity(result);
        }
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /u.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
