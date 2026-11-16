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
import { fillFirstThrottle } from "../src/rack-attack";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/api/internal/ai_product_details_generations_parity_spec.rb: POST /internal/ai_product_details_generations. The model
// exchange of each fixture is a WebMock stub in Rails; here a stand-in server answers Node's call with the recorded response, in order, and the
// test asserts that the requests it received are the recorded ones (path, content type and JSON body). No example reaches a live model.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const SPEC_DIR = "parity/fixtures/requests/api/internal/ai_product_details_generations_parity_spec";
const ROUTE_FLAGS = "nextjs_internal_ai_product_details";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const MODEL_PATH = "/v1/chat/completions";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.headers.link",
    "response.headers.cache-control",
    // The window ends at another instant than in the recording; checked against the clock below.
    "response.headers.retry-after",
    "response.json.retry_after",
    "response.json.data.duration_in_seconds",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
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

type Call = { method: string; path: string; contentType: string; body: unknown; authorization: string };
type Answer = { status: number; contentType: string; body: string };

describe.skipIf(!url)("Api::Internal::AiProductDetailsGenerationsController", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  let model: Server;
  const handedBack: { method: string; url: string }[] = [];
  const modelCalls: Call[] = [];
  let answers: Answer[] = [];
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
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      request.on("end", () => response.writeHead(204).end());
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    model = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        modelCalls.push({
          method: request.method ?? "",
          path: request.url ?? "",
          contentType: request.headers["content-type"] ?? "",
          authorization: request.headers.authorization ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        const answer = answers.shift() ?? { status: 599, contentType: "text/plain", body: "no recorded answer" };
        response.writeHead(answer.status, { "content-type": answer.contentType }).end(answer.body);
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
      OPENAI_URI_BASE: `http://127.0.0.1:${(model.address() as { port: number }).port}/`,
      OPENAI_ACCESS_TOKEN: "stand-in-token",
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
    await new Promise((resolve) => model.close(resolve));
    await closeAllRedis();
    await redis.quit();
    await es.close();
    await client.$disconnect();
    process.env = saved;
  });

  const options = (fill = false) => ({
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0], exchange?: { request: never }) => {
        await redisSeeder(redis).reset(entries);
        if (fill && exchange) await fillFirstThrottle(redis, exchange.request);
        // User#eligible_for_ai_product_generation? sums the seller's sales in the purchases index
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
    expect(cases.length).toBeGreaterThan(20);
  });

  it(
    "compiles the handlers",
    async () => {
      const [, file, index] = cases.find(([name]) => name.includes("returns-the-details"))!;
      answers = recordedModelAnswers(file, index);
      await replayFixtureExchange(file, index, options()).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      const fixture = loadFixture(file);
      const exchange = fixture.exchanges[index]!;
      const recorded = recordedModelCalls(file, index);
      answers = recordedModelAnswers(file, index);
      modelCalls.length = 0;
      handedBack.length = 0;
      try {
        const result = await replayFixtureExchange(
          fixture,
          index,
          options(name.includes("rack-attack-throttle-answers-429")),
        );
        if (name.includes("hands-a-visitor")) {
          expect(handedBack).toHaveLength(1);
          expect(modelCalls).toHaveLength(0);
          return;
        }
        expect(handedBack).toHaveLength(0);
        assertParity(result);
        // The stand-in saw exactly the requests Rails sent the model.
        expect(modelCalls).toHaveLength(recorded.length);
        modelCalls.forEach((call, position) => {
          expect(call.method).toBe(recorded[position]!.method);
          expect(call.path).toBe(MODEL_PATH);
          expect(call.contentType).toBe("application/json");
          expect(call.authorization).toBe("Bearer stand-in-token");
          expect(call.body).toEqual(recorded[position]!.body);
        });
        const actual = result.exchanges[0]!.actual.response;
        if (actual.status === 429 && exchange.response.json) {
          const retryAfter = Number(actual.headers["retry-after"]);
          expect(retryAfter).toBeGreaterThan(0);
          expect(retryAfter).toBeLessThanOrEqual(3600);
        }
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

const modelEntries = (file: string, index: number) =>
  loadFixture(file).exchanges[index]!.http.filter((entry) => new URL(entry.url).hostname === "api.openai.com");

function recordedModelCalls(file: string, index: number) {
  return modelEntries(file, index).map((entry) => ({
    method: entry.method,
    body: JSON.parse(entry.body ?? "null") as unknown,
  }));
}

function recordedModelAnswers(file: string, index: number): Answer[] {
  return modelEntries(file, index).map((entry) => ({
    status: entry.response.status ?? 200,
    contentType: entry.response.contentType ?? "application/json",
    body: entry.response.body ?? "",
  }));
}
