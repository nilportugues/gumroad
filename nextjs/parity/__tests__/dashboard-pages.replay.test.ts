import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { bulkIndex, ELASTICSEARCH_HOST, recreateIndex, replayIndexName, seededDocuments } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the seller dashboards that search Elasticsearch: spec/requests/{audience_dashboard,...}_signed_in_spec.rb.
// Each fixture is a login followed by the request under test; only the last request of each example is
// replayed, against `next dev` with the page flags on. The indices the pages search are rebuilt before every
// exchange, under the names the server derives from ES_INDEX_SUFFIX: from the seeded rows for the ones backed
// by a table, from the documents the recorder captured for the ones that are not.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["audience_dashboard_signed_in_spec", "seller_payment_details_signed_in_spec"];
// The port makes no Stripe call: a flagged seller whose merchant account Stripe would be asked about, or who has a
// requested compliance request, is handed to Rails whole. Those examples are proven by the request reaching Rails.
const HANDED_BACK = /asks-stripe|sends-a-seller-stripe-has-asked/;
const RAILS_ANSWER = "rails answered";
const ROUTE_FLAGS = "nextjs_audience";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];
const dynamoPrefix = testEnv("DYNAMODB_TABLE_PREFIX");
const awsAccessKeyId = testEnv("AWS_ACCESS_KEY_ID");
const awsSecretAccessKey = testEnv("AWS_SECRET_ACCESS_KEY");

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

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("seller dashboards parity when signed in", () => {
  let rails: Server;
  const railsRequests: { method?: string; url?: string; host?: string }[] = [];
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    // Stands in for the Rails app, to see what the port hands back.
    rails = createServer((request, response) => {
      railsRequests.push({ method: request.method, url: request.url, host: request.headers["x-forwarded-host"] as string | undefined });
      response.writeHead(200, { "content-type": "text/plain" }).end(RAILS_ANSWER);
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsOrigin = `http://127.0.0.1:${(rails.address() as { port: number }).port}`;
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
    async (_name, file, index) => {
      try {
        railsRequests.length = 0;
        const result = await replayFixtureExchange(file, index, {
          sql,
          redis: {
            async reset(entries, exchange, now) {
              await redisSeeder(redis).reset(entries);
              if (!exchange || !now) return;
              const events = { model: "ConfirmedFollowerEvent", name: replayIndexName("confirmed_follower_events", ES_INDEX_SUFFIX) } as const;
              await recreateIndex(es, events);
              await bulkIndex(es, events.name, seededDocuments(exchange, "ConfirmedFollowerEvent", now).map((body) => ({ body })));
            },
          },
          transport: httpTransport(server.baseUrl),
          interceptHttp: false,
          rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
          compare: _name.includes("404") ? { ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
        });
        if (HANDED_BACK.test(_name)) {
          expect(railsRequests.at(-1)).toMatchObject({ method: "GET", url: "/dashboard/audience", host: "app.test.gumroad.com:31337" });
          expect(result.exchanges[0]!.actual.response.body).toBe(RAILS_ANSWER);
        } else {
          assertParity(result);
        }
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
