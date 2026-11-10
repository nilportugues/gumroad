import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

// Replays spec/requests/offer_codes_compute_discount_parity_spec.rb: GET /offer_codes/compute_discount, which the port
// answers from the cart of permalinks without writing anything.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/offer_codes_compute_discount_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

const COMPARE = {
  ignore: [
    "http",
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
  ],
};

const cases = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixturePath = path.join(DIR, file);
    return [
      file.replace(/\.json$/u, "").replace(/^offer-codes-compute-discount-/u, ""),
      fixturePath,
      loadFixture(fixturePath).exchanges.length - 1,
    ] as const;
  });

describe.skipIf(!url)("Offer codes compute_discount parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((_, response) => response.writeHead(218, { "x-handed-back": "rails" }).end());
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_checkout_offer_codes",
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as AddressInfo).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
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
    expect(cases).toHaveLength(26);
  });

  it.each(cases)(
    "%s",
    async (_name, fixturePath, index) => {
      const result = await replayFixtureExchange(fixturePath, index, {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        compare: COMPARE,
      });
      try {
        assertParity(result);
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\n--- server ---\n${server.output().split("\n").slice(-25).join("\n")}`,
        );
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
