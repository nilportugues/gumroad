import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { type CapturedHttp } from "../src/fixture";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/help_center_signed_in_gaps_spec.rb: signed-in visits whose shared props read an
// uploaded avatar (Active Storage rows and the bucket), the store agent's sales bar (an Elasticsearch
// aggregation, answered here by a stand-in that serves what Rails got), a US minor's guardian and a
// payout setup rejection note.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURE_DIR = "parity/fixtures/requests/help_center_signed_in_gaps_spec";
const ROUTE_FLAGS = "nextjs_help_center_category,nextjs_help_center_articles";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const MINIO_ENDPOINT = "http://localhost:9010";
const MINIO_CREDENTIALS = { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" };
const PUBLIC_BUCKET = "gumroad-specs";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/m.exec(envTest)?.[1];

// Same exclusions as help-center-signed-in.replay.test.ts, plus the Elasticsearch calls, which this
// test checks itself against the stand-in.
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
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    "http",
  ],
};

const files = url ? readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json")) : [];
const cases = files.map((file) => [file.replace(/^help-center-when-signed-in-with-data-the-shared-props-read-/, "").replace(/\.json$/, ""), file] as const);

type Request = { body: string };

// Elasticsearch as Rails saw it: each `_search` is answered with the response recorded for the same body.
function startFakeElasticsearch() {
  const recorded: CapturedHttp[] = [];
  const received: Request[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      // The client checks it is talking to Elasticsearch before its first request.
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
        response.end(JSON.stringify({ version: { number: "7.17.0", build_flavor: "default" }, tagline: "You Know, for Search" }));
        return;
      }
      received.push({ body });
      const match = recorded.find((call) => call.body === body);
      response.writeHead(match ? (match.response.status ?? 200) : 500, { "content-type": "application/json" });
      response.end(match ? (match.response.body ?? "{}") : JSON.stringify({ error: `no recorded Elasticsearch call for ${body}` }));
    });
  });
  return {
    server,
    recorded,
    received,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
  };
}

// The avatar files Rails uploaded to the public bucket; put back any a cleanup removed.
async function ensureBlobsInBucket(keys: string[]) {
  const s3 = new S3Client({ region: "us-east-1", endpoint: MINIO_ENDPOINT, forcePathStyle: true, credentials: MINIO_CREDENTIALS });
  for (const Key of keys) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: PUBLIC_BUCKET, Key }));
    } catch {
      await s3.send(new PutObjectCommand({ Bucket: PUBLIC_BUCKET, Key, Body: "x" }));
    }
  }
}

describe.skipIf(!url)("HelpCenter parity when signed in, with data the shared props read", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let elasticsearchHost = "";
  const elasticsearch = startFakeElasticsearch();
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    elasticsearchHost = await elasticsearch.listen();
    server = await boot();
  }, FIRST_COMPILE_TIMEOUT_MS);

  const boot = () =>
    startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: "http://rails.invalid",
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      ELASTICSEARCH_HOST: elasticsearchHost,
      AWS_S3_ENDPOINT: MINIO_ENDPOINT,
      AWS_ACCESS_KEY_ID: MINIO_CREDENTIALS.accessKeyId,
      AWS_SECRET_ACCESS_KEY: MINIO_CREDENTIALS.secretAccessKey,
    });

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => elasticsearch.server.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(16);
  });

  it.each(cases)(
    "%s",
    async (name, file) => {
      // The port keeps Rails.cache in memory under test, and every fixture numbers its attachments from 1.
      if (name.startsWith("an-uploaded-avatar")) {
        await server.stop();
        server = await boot();
      }
      const fixture = loadFixture(path.join(FIXTURE_DIR, file));
      const index = fixture.exchanges.length - 1;
      const exchange = fixture.exchanges[index]!;
      const blobKeys = (exchange.seed.tables?.active_storage_blobs?.rows ?? []).map((row) => String((row as Record<string, unknown>).key));
      await ensureBlobsInBucket(blobKeys);
      elasticsearch.recorded.splice(0, elasticsearch.recorded.length, ...exchange.http.filter((call) => call.url.includes("/_search")));
      elasticsearch.received.length = 0;

      const result = await replayFixtureExchange(fixture, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, loaded, now) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
      // Rails asked Elasticsearch exactly what the port asked, in the same order.
      expect(elasticsearch.received.map((call) => call.body)).toEqual(elasticsearch.recorded.map((call) => call.body));
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
