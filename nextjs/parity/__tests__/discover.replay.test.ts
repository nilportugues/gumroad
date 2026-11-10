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
  bulkIndex,
  ELASTICSEARCH_HOST,
  recreateIndex,
  reindexProducts,
  reindexPurchases,
  replayIndexName,
  seededDocuments,
} from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays Discover (spec/requests/discover_parity_spec.rb), signed out and signed in. Only the last request of each
// example is replayed, against `next dev` with the page flag on. The `products` index is rebuilt from the seeded
// rows before every exchange, under the name the server derives from ES_INDEX_SUFFIX. What the port hands to Rails
// (a signed-in visitor's wishlists, a buyer with purchases) is proven by the request reaching it.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests/discover_parity_spec";
// A signed-in seller is the service's current_seller, and a buyer's cart or purchases make curated products. The
// category wishlists example seeds no taxonomy on its products, so Rails fails on the empty `FIELD(id, )` list.
const HANDED_BACK =
  /signed-in-answers-the-deferred-recommended-wishlists|buyer-who-has-purchased|wishlists-for-a-category/;
const RAILS_ANSWER = "rails answered";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity-discover";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];

// Next.js owns what it renders and caches: Vite asset preloads, `vary`, and the per-response random values.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "http",
    // The replayer's clock is read before the first compile of a page, which can take longer than the token's window.
    "db.discover_searches.inserted.*.created_at",
    "db.discover_searches.inserted.*.updated_at",
    "db.discover_search_suggestions.inserted.*.created_at",
    "db.discover_search_suggestions.inserted.*.updated_at",
    // A visitor without the cookie gets a guid minted per request, which the row then carries.
    "db.discover_searches.inserted.*.browser_guid",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
  ],
};

const cases = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/, ""),
            path.join(FIXTURES, file),
            loadFixture(path.join(FIXTURES, file)).exchanges.length - 1,
          ] as const,
      )
  : [];

describe.skipIf(!url)("Discover parity", () => {
  let rails: Server;
  const railsRequests: { method?: string; url?: string }[] = [];
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    // Stands in for the Rails app, to see what the port hands back.
    rails = createServer((request, response) => {
      railsRequests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "text/plain" }).end(RAILS_ANSWER);
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsOrigin = `http://127.0.0.1:${(rails.address() as { port: number }).port}`;
    // The port's models, which the replay uses to build documents, connect through DATABASE_URL.
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: "nextjs_discover",
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: railsOrigin,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
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

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        railsRequests.length = 0;
        const result = await replayFixtureExchange(file, index, {
          sql,
          redis: {
            async reset(entries, exchange, now) {
              await redisSeeder(redis).reset(entries);
              if (!exchange || !now) return;
              // A product document reads its sales from the purchases index.
              const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
              await recreateIndex(es, purchases);
              await reindexPurchases(es, purchases.name, sql);
              const products = { model: "Link", name: replayIndexName("products", ES_INDEX_SUFFIX) } as const;
              await recreateIndex(es, products);
              await reindexProducts(es, products.name, sql);
              // Autocomplete history and recently viewed read the visitor's page views.
              const views = {
                model: "ProductPageView",
                name: replayIndexName("product_page_views", ES_INDEX_SUFFIX),
              } as const;
              await recreateIndex(es, views);
              await bulkIndex(
                es,
                views.name,
                seededDocuments(exchange, "ProductPageView", now).map((body) => ({ body })),
              );
            },
          },
          transport: httpTransport(server.baseUrl),
          interceptHttp: false,
          rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
          compare: COMPARE,
        });
        if (HANDED_BACK.test(name)) {
          expect(railsRequests.at(-1)).toMatchObject({
            method: "GET",
            url: `${result.exchanges[0]!.expected.request.path}${result.exchanges[0]!.expected.request.query ? `?${result.exchanges[0]!.expected.request.query}` : ""}`,
          });
          expect(result.exchanges[0]!.actual.response.body).toBe(RAILS_ANSWER);
        } else {
          assertParity(result);
        }
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => /error|Error|at /.test(line))
          .slice(-25)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
