import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/public_files_parity_spec.rb (robots.txt, llms.txt, the favicon, the IndexNow key, ACME challenges,
// crossdomain.xml), recorded through the full Rack stack. The GitHub stars counter reads Rails.cache, which a request spec fills
// in the Rails process only: github-stars.test.ts covers it.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIRS = ["public_files_parity_spec"].filter((dir) => existsSync(path.join(FIXTURES_ROOT, dir)));
const NOT_REPLAYED = /github-stars/;
const ROUTE_FLAGS = ["nextjs_robots", "nextjs_llms", "nextjs_crossdomain", "nextjs_favicon", "nextjs_indexnow_key", "nextjs_acme_challenge"];
const INDEXNOW_KEY = "AbCd-1234-EfGh-5678";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    // Masked per response; the ACME challenge's is raw bytes of the session's global token.
    "response.cookies.XSRF-TOKEN.value",
  ],
};

const cases = SPEC_DIRS.flatMap((dir) =>
  readdirSync(path.join(FIXTURES_ROOT, dir))
    .filter((file) => file.endsWith(".json") && !NOT_REPLAYED.test(file))
    .map((file) => {
      const fixturePath = path.join(FIXTURES_ROOT, dir, file);
      return [file.replace(/\.json$/, ""), fixturePath, loadFixture(fixturePath).exchanges.length - 1] as const;
    }),
);

describe.skipIf(!url)("WS-11 public files parity", () => {
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
      INDEXNOW_KEY,
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
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
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line) && !/built-in version of this loader/.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
