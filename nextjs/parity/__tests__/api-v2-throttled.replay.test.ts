import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { expectRetryAfter, fillFirstThrottle, rackAttackCounters } from "../src/rack-attack";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/api/v2/products_throttled_parity_spec.rb: the six v2 routes Rack::Attack throttles, which Node counts through the
// single counter ahead of the action chain. Node answers the parameter refusals; "hands a ..." fixtures are the writes, the search, the
// sanitizer and the download, which must reach the Rails stand-in whole, write nothing and leave its count taken back (a counter at zero) (Rails counts them again).
// "counts ..." fixtures also compare the number of Rack::Attack keys Rails wrote; "answers 429 ..." put the first throttle at its limit.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/api/v2/products_throttled_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

const COMPARE = {
  ignore: [
    "http",
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.headers.cache-control",
    // The window ends at a different instant than in the recording; the test checks the value against the clock.
    "response.headers.retry-after",
    "response.cookies.XSRF-TOKEN.value",
    "response.cookies.__profilin",
    "db.versions",
  ],
};

// The Rack::Attack keys Rails wrote for a "counts ..." example, by route.
const COUNTED_KEYS: [RegExp, number][] = [
  [/post-v2-products-the-rack-attack-throttle-counts/u, 5],
  [/put-and-patch-v2-products-id-the-rack-attack-throttle-counts/u, 11],
  [/get-v2-products-comps-the-rack-attack-throttle-counts/u, 11],
  [/preview-custom-html-the-rack-attack-throttle-counts/u, 11],
  [/post-v2-media-the-rack-attack-throttle-counts/u, 2],
];

const cases = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/u, ""),
            path.join(DIR, file),
            loadFixture(path.join(DIR, file)).exchanges.length - 1,
          ] as const,
      )
  : [];

describe.skipIf(!url)("API v2 throttled routes parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      request.resume();
      request.on("end", () => response.writeHead(218, { "x-handed-back": "rails" }).end());
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_api_v2_products,nextjs_api_v2_media",
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => (rails ? rails.close(() => resolve()) : resolve()));
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  const replay = (file: string, index: number, fill: boolean) =>
    replayFixtureExchange(file, index, {
      sql,
      redis: {
        async reset(entries, exchange) {
          await redisSeeder(redis).reset(entries);
          if (fill && exchange) await fillFirstThrottle(redis, exchange.request);
        },
      },
      transport: httpTransport(server.baseUrl),
      interceptHttp: false,
      compare: COMPARE,
    });

  // The first request to a route compiles it, and a throttle window is a minute: compile before any example fills a counter.
  it(
    "compiles the handlers",
    async () => {
      const warmed = new Set<string>();
      for (const [, file, index] of cases) {
        const { method, path: requestPath } = loadFixture(file).exchanges[index]!.request;
        const route = `${method} ${requestPath.replace(/\/[^/]*==[^/]*/u, "/:id")}`;
        if (warmed.has(route)) continue;
        warmed.add(route);
        await replay(file, index, false).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      handedBack.length = 0;
      try {
        const result = await replay(file, index, name.includes("answers-429"));
        const counters = await rackAttackCounters(redis);
        if (name.includes("hands-")) {
          const expected = loadFixture(file).exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]!.method).toBe(expected.method);
          expect(Object.keys(result.exchanges[0]!.actual.db ?? {})).toEqual([]);
          // Rails counts a handed-back request itself: Node's count is taken back.
          expect(Object.values(counters).every((count) => count === 0)).toBe(true);
          return;
        }
        expect(handedBack).toHaveLength(0);
        assertParity(result);
        expectRetryAfter(result.exchanges[0]!.actual.response, [64, 600]);
        const counted = COUNTED_KEYS.find(([pattern]) => pattern.test(name));
        if (counted) {
          expect(Object.keys(counters)).toHaveLength(counted[1]);
          expect(new Set(Object.values(counters))).toEqual(new Set([1]));
        }
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\n--- server ---\n${server.output().split("\n").slice(-25).join("\n")}`,
        );
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
