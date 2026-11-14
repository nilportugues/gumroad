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
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/home_pages_parity_spec.rb: HomeController#features_md. A request with a cookie or a utm parameter ("hands a ...")
// must reach the stand-in Rails untouched; the other home#* actions are ERB pages and stay Rails'.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = path.join("parity/fixtures/requests", "home_pages_parity_spec");
const ROUTE_FLAGS = "nextjs_features_md";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    "response.cookies.__profilin",
    "db.versions",
  ],
};

const cases = (existsSync(FIXTURES) ? readdirSync(FIXTURES) : [])
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixturePath = path.join(FIXTURES, file);
    return [file.replace(/\.json$/u, ""), fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
  });

describe.skipIf(!url)("HomeController#features_md", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await new Promise((resolve) => rails?.close(resolve));
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
    async (name, fixturePath, index) => {
      handedBack.length = 0;
      const options = {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        // features.md prints "Last updated: <today>".
        driftAlso: ["body" as const],
        compare: COMPARE,
      };
      try {
        const result = await replayFixtureExchange(fixturePath, index, options);
        if (name.includes("hands-a-")) {
          const request = loadFixture(fixturePath).exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(handedBack[0]!.url.split("?")[0]).toBe("/features.md");
          expect(Object.keys(result.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        expect(handedBack).toHaveLength(0);
        assertParity(result);
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => !/built-in version of this loader|^\s*$/u.test(line))
          .slice(-40)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
