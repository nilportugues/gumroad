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
import { withoutRailsOnly } from "../src/rails-only";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/offer_codes_selection_discounts_parity_spec.rb: GET /offer_codes/selection_discounts. The last request of each
// fixture is replayed against `next dev` with the route flag on. An example named "hands a ..." must reach the Rails stand-in whole and
// write nothing; every other one is compared on status, headers, body and the rows it wrote.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/offer_codes_selection_discounts_parity_spec";
const ROUTE_FLAGS = "nextjs_checkout_selection_discounts";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

const COMPARE = {
  ignore: [
    "http",
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
  ],
};

const allCases = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/u, "").replace(/^offer-codes-selection-discounts-/u, ""),
            path.join(DIR, file),
            loadFixture(path.join(DIR, file)).exchanges.length - 1,
          ] as const,
      )
  : [];
const cases = withoutRailsOnly(allCases, ([, file, index]) => loadFixture(file).exchanges[index]!.request);

describe.skipIf(!url)("Offer codes selection_discounts parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((request, response) => {
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      response.writeHead(204).end();
    });
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
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${(rails.address() as { port: number }).port}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
    });
  }, FIRST_COMPILE_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(allCases).toHaveLength(39);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      const options = {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (
          request: Parameters<typeof reencryptCookies>[0],
          loaded: Parameters<typeof reencryptCookies>[1],
          now: Date,
        ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
        compare: COMPARE,
      };
      try {
        const fixture = loadFixture(file);
        if (name.startsWith("what-node-leaves-to-rails-hands-a-") || name.includes("-hands-a-")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toEqual([
            { method: request.method, url: request.query ? `${request.path}?${request.query}` : request.path },
          ]);
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, options));
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\n--- server ---\n${server.output().split("\n").slice(-25).join("\n")}`,
        );
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
