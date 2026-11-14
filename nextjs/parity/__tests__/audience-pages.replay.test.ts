import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";
import { INSTALLMENT_FLAG_MAPPING, selectedFlags } from "@/server/search/flags";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// The emails list searches Elasticsearch, which the replayer does not seed: after each exchange's rows
// are in MySQL, the installments index (the name the server derives with no ES_INDEX_SUFFIX) is rebuilt
// from them with the settings and mappings Rails' test index holds.
const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200";
const RAILS_INSTALLMENT_INDEX = "installment-test";
const REPLAY_INSTALLMENT_INDEX = "installments";
const isoOrNull = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : new Date(String(value).replace(" ", "T") + "Z").toISOString());

async function reindexInstallments(sql: SqlExecutor) {
  const es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
  const source = (await es.indices.get({ index: RAILS_INSTALLMENT_INDEX })).body[RAILS_INSTALLMENT_INDEX];
  await es.indices.delete({ index: REPLAY_INSTALLMENT_INDEX }, { ignore: [404] });
  await es.indices.create({
    index: REPLAY_INSTALLMENT_INDEX,
    body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0, analysis: source.settings.index.analysis } }, mappings: source.mappings },
  });
  const rows = await sql.query("SELECT id, name, message, seller_id, workflow_id, created_at, deleted_at, published_at, flags FROM installments");
  const body = rows.flatMap((row) => [
    { index: { _index: REPLAY_INSTALLMENT_INDEX, _id: String(row.id) } },
    {
      id: Number(row.id),
      message: row.message,
      name: row.name,
      seller_id: row.seller_id === null ? null : Number(row.seller_id),
      workflow_id: row.workflow_id === null ? null : Number(row.workflow_id),
      created_at: isoOrNull(row.created_at),
      deleted_at: isoOrNull(row.deleted_at),
      published_at: isoOrNull(row.published_at),
      selected_flags: selectedFlags(INSTALLMENT_FLAG_MAPPING, BigInt(row.flags as number | bigint)),
    },
  ]);
  if (body.length > 0) await es.bulk({ body, refresh: true });
  await es.close();
}

// Replays the signed-in audience pages: spec/requests/{utm_links,followers,workflows,emails}_signed_in_spec.rb.
// Each fixture is a login followed by the request under test; only the last request of each example
// is replayed (the earlier ones set the scene), against `next dev` with the page flags on.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["utm_links_signed_in_spec", "followers_signed_in_spec", "workflows_signed_in_spec", "emails_signed_in_spec"];
const ROUTE_FLAGS = "nextjs_utm_links_index,nextjs_utm_links_form,nextjs_followers,nextjs_workflows,nextjs_emails";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];
const dynamoPrefix = testEnv("DYNAMODB_TABLE_PREFIX");
const awsAccessKeyId = testEnv("AWS_ACCESS_KEY_ID");
const awsSecretAccessKey = testEnv("AWS_SECRET_ACCESS_KEY");

// Next.js owns what it renders and caches: Vite asset preloads, `vary`, and the per-response random
// values (CSP nonce, masked CSRF tokens). Rails sends the new-link form a fresh random permalink.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    // The page view event: the replay client sends its own User-Agent (Rails recorded none), and the
    // first request to a route compiles it.
    // Rails' DynamoDB reads are recorded; the port's run in the server process, out of the replayer's reach.
    "http",
    "db.events.inserted.*.browser",
    "db.events.inserted.*.browser_fingerprint",
    "db.events.inserted.*.created_at",
    "db.events.inserted.*.updated_at",
    "db.versions",
    "db.users.updated.*.changes.updated_at",
    "response.headers.link",
    "response.headers.vary",
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    // A quota deferral is a Redis timestamp, which the replayer does not move with the clock.
    "response.inertia.props.installments.*.delivery.scheduled_for",
    // SecureRandom permalinks
    "response.inertia.props.context.short_url",
    "response.inertia.props.utm_link.short_url",
    "response.inertia.props.additional_metadata.new_permalink",
    "response.json.props.additional_metadata.new_permalink",
    "response.inertia.props.utm_links.*.short_url",
  ],
};

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/u, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("audience pages parity when signed in", () => {
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
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      // The S3 and DynamoDB settings the email forms and the engagement counters read.
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
        const result = await replayFixtureExchange(file, index, {
          sql,
          redis: {
            async reset(entries) {
              await redisSeeder(redis).reset(entries);
              await reindexInstallments(sql);
            },
          },
          transport: httpTransport(server.baseUrl),
          interceptHttp: false,
          rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
          // The test environment renders Rails' exception page for a 404; production sends public/404.html.
          compare: _name.includes("404")
            ? { ignore: [...COMPARE.ignore, "response.body"] }
            : // The seed's times are relative to the replay's clock, so a formatted date moves with the day it
              // replays on; followers.test.ts pins the format.
              { ignore: [...COMPARE.ignore, "response.inertia.props.followers.*.formatted_confirmed_on", "response.json.props.followers.*.formatted_confirmed_on"] },
        });
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /u.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
