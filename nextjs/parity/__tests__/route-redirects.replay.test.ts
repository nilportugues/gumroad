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
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the redirect-only routes of config/routes.rb (spec/requests/route_redirects_parity_spec.rb and
// route_redirects_signed_in_spec.rb): one request per fixture, the last exchange. A fixture named `hands-a-...` is a query the proxy
// cannot rebuild the way Rails does; it has to reach the stand-in for Rails untouched.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES_ROOT = "parity/fixtures/requests";
const SPEC_DIRS = ["route_redirects_parity_spec", "route_redirects_signed_in_spec"].filter((dir) =>
  existsSync(path.join(FIXTURES_ROOT, dir)),
);
const ROUTE_FLAGS = ["nextjs_route_redirects", "nextjs_auth_devise_redirects"];
const FIRST_COMPILE_TIMEOUT_MS = 240_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");

// Next.js owns `vary` (it adds Accept-Encoding); the CSRF cookie of the login page the signed-in fixtures fetch first is not under test.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.versions",
    "db.users.updated.*.changes.updated_at",
  ],
};

const cases = SPEC_DIRS.flatMap((dir) =>
  readdirSync(path.join(FIXTURES_ROOT, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fixturePath = path.join(FIXTURES_ROOT, dir, file);
      return [
        `${dir.replace(/_(signed_in_)?spec$/gu, "")}: ${file.replace(/\.json$/u, "")}`,
        fixturePath,
        loadFixture(fixturePath).exchanges.length - 1,
      ] as const;
    }),
);

describe.skipIf(!url)("route redirects parity", () => {
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
      handedBack.push({ method: request.method ?? "", url: request.url ?? "" });
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS.join(","),
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
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

  const options = () => ({
    sql,
    redis: redisSeeder(redis),
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    driftDates: false,
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare: COMPARE,
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (name, fixturePath, index) => {
      try {
        if (name.includes("hands-a")) {
          handedBack.length = 0;
          await replayFixtureExchange(fixturePath, index, options());
          const request = loadFixture(fixturePath).exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          // fetch percent-encodes the brackets the recorded query carries raw.
          expect(handedBack[0]!.method).toBe(request.method);
          expect(decodeURIComponent(handedBack[0]!.url)).toBe(decodeURIComponent(`${request.path}?${request.query}`));
          return;
        }
        assertParity(await replayFixtureExchange(fixturePath, index, options()));
      } catch (error) {
        const logs = server
          .output()
          .split("\n")
          .filter((line) => /error|Error|at /u.test(line))
          .slice(-25)
          .join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
