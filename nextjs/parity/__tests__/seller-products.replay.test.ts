import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { recreateIndex, reindexPurchases } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the seller's products pages (spec/requests/seller_products_*_spec.rb): signed-in visits recorded
// through the full Rack stack after a real login. Each fixture is a login (and often an account switch)
// followed by the request under test, the last exchange.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIRS = readdirSync(FIXTURES_ROOT).filter(
  (dir) => /^seller_products_.*_spec$/u.test(dir) && existsSync(path.join(FIXTURES_ROOT, dir)),
);
const ROUTE_FLAGS = [
  "nextjs_products_index",
  "nextjs_products_archived",
  "nextjs_products_affiliated",
  "nextjs_collabs",
  "nextjs_products_new",
  "nextjs_products_edit",
  "nextjs_bundle_editor",
];
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];

// The product pages sum each product's sales in Elasticsearch, which the replayer does not seed: an
// empty purchases index (the mapping Rails' test index holds, under the name the server derives with no
// ES_INDEX_SUFFIX) is what a seller without sales gets.
const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200";
const RAILS_PURCHASE_INDEX = "purchase-test";
const REPLAY_PURCHASE_INDEX = "purchases";

async function createEmptyPurchasesIndex() {
  const es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
  const source = (await es.indices.get({ index: RAILS_PURCHASE_INDEX })).body[RAILS_PURCHASE_INDEX];
  await es.indices.delete({ index: REPLAY_PURCHASE_INDEX }, { ignore: [404] });
  await es.indices.create({
    index: REPLAY_PURCHASE_INDEX,
    body: {
      settings: { index: { number_of_shards: 1, number_of_replicas: 0, analysis: source.settings.index.analysis } },
      mappings: source.mappings,
    },
  });
  await es.close();
}

// Next.js owns what it renders and caches: Vite asset preloads, `vary`, and the per-response random
// values (CSP nonce, masked CSRF tokens).
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
    // Rails' Elasticsearch calls are recorded; the port's run in the server process, out of the replayer's reach.
    "http",
    // One month from today: a date the fixture recorded on another day (new-page.test.ts pins the arithmetic).
    "response.inertia.props.release_at_date",
    // The editor: an HMAC under the recorder's secret_key_base (edit.test.ts pins the digest) and the
    // environment's S3, Google and Dropbox settings.
    "response.inertia.props.product.editor_revision",
    "response.json.props.product.editor_revision",
    "response.inertia.props.s3_url",
    "response.inertia.props.aws_key",
    "response.inertia.props.google_client_id",
    "response.inertia.props.dropbox_api_key",
    "response.json.props.s3_url",
    "response.json.props.aws_key",
    "response.json.props.google_client_id",
    "response.json.props.dropbox_api_key",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.inertia.props._inertia_meta.1.content",
    "response.json.props._inertia_meta.1.content",
    "response.body",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
  ],
};

const cases = SPEC_DIRS.flatMap((dir) =>
  readdirSync(path.join(FIXTURES_ROOT, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixturePath = path.join(FIXTURES_ROOT, dir, file);
      return [
        `${dir.replace(/^seller_products_|_spec$/gu, "")}: ${file.replace(/\.json$/u, "")}`,
        fixturePath,
        loadFixture(fixturePath).exchanges.length - 1,
      ] as const;
    }),
);

describe.skipIf(!url)("Seller products pages parity when signed in", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    await createEmptyPurchasesIndex();
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
      ELASTICSEARCH_HOST,
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (_name, fixturePath, index) => {
      const result = await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: {
          // The editor counts a product's sales in Elasticsearch: rebuild the index from the seeded purchases.
          async reset(entries, exchange) {
            await redisSeeder(redis).reset(entries);
            if (!exchange) return;
            const es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
            try {
              await recreateIndex(es, { model: "Purchase", name: REPLAY_PURCHASE_INDEX });
              await reindexPurchases(es, REPLAY_PURCHASE_INDEX, sql);
            } finally {
              await es.close();
            }
          },
        },
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const output = server.output();
        if (process.env.PARITY_DUMP_SERVER) writeFileSync(process.env.PARITY_DUMP_SERVER, output);
        const logs = output
          .split("\n")
          .filter((line) => /error|Error|at /u.test(line))
          .slice(-25)
          .join("\n");
        // A page graph that calls a Routes helper the compat table lacks fails to compile: name them all.
        const missing = [
          ...new Set([...output.matchAll(/Export (\w+) doesn't exist/gu)].map((match) => match[1])),
        ].join(", ");
        throw new Error(
          `${(error as Error).message}\n--- server ---\n${logs}${missing ? `\nmissing Routes helpers: ${missing}` : ""}`,
        );
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
