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
import { reencryptCookies, redisSeeder } from "../src/session";

// LinksController#show, recorded through the full Rack stack by spec/requests/product_page_parity_spec.rb.
// The port answers the redirects and 404s of the filters and hands a request that would render back to
// Rails, which a stand-in origin here marks.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = "parity/fixtures/requests/product_page_parity_spec";
const FIRST_COMPILE_TIMEOUT_MS = 180_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const HANDED_BACK_STATUS = 218;
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
const numericKey = "0";

const COMPARE = {
  ignore: [
    // Added by the test environment's Rack stack, not by the app.
    "response.headers.x-original-headers-class",
    // Next.js owns Cache-Control on rendered HTML (no-store).
    "response.headers.cache-control",
    "response.headers.link",
    "response.headers.vary",
    "response.cookies.XSRF-TOKEN.value",
    "response.cookies.__profilin",
    "db.versions",
  ],
};

type Case = { name: string; file: string; index: number; served: boolean; status: number; ignore: string[] };

// The route gate (hostKindOf) sends a host that no alive seller owns to Rails whole: its catch-all is the 404.
const GATE_HANDS_BACK = new Set(["product-page-on-a-seller-subdomain-is-a-404-for-a-product-of-a-deleted-seller"]);

// A 301 or 404, and the 302 to a coffee product's own page, are the filters' answers; the rest renders.
const cases: Case[] = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const fixture = loadFixture(path.join(DIR, file));
    const index = fixture.exchanges.length - 1;
    const response = fixture.exchanges[index]!.response;
    const served = response.status === 301 || response.status === 404 || (response.status === 302 && /\/coffee(\?|$)/.test(response.location ?? ""));
    // The cookie's value is the time it was set.
    const affiliate = Object.keys(response.cookies ?? {}).filter((name) => name.startsWith("_gumroad_affiliate_id_"));
    const name = file.replace(/\.json$/, "");
    return { name, file: path.join(DIR, file), index, served: served && !GATE_HANDS_BACK.has(name), status: response.status, ignore: affiliate.map((name) => `response.cookies.${name}.value`) };
  });

describe.skipIf(!url)("Product page parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const saved = { ...process.env };

  beforeAll(async () => {
    rails = createServer((_, response) => {
      response.writeHead(HANDED_BACK_STATUS, { "x-handed-back": "rails" });
      response.end("handed back");
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: numericKey,
      NEXTJS_ROUTE_FLAGS: "nextjs_product_page",
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
    expect(cases.filter((c) => c.served).length).toBeGreaterThan(10);
    expect(cases.filter((c) => !c.served).length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      const compare = { ...COMPARE, ignore: [...COMPARE.ignore, ...c.ignore, ...(c.status === 404 ? ["response.body"] : [])] };
      const options = {
        sql,
        redis: redisSeeder(redis),
        transport: httpTransport(server.baseUrl),
        interceptHttp: false,
        rewriteRequest: (request: Request, fixture: Parameters<typeof reencryptCookies>[1], now: Date) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
      };
      if (!c.served) {
        // The request the filters cannot prove goes to Rails whole.
        const result = await replayFixtureExchange(c.file, c.index, { ...options, compare: { ignore: ["**"] } });
        const actual = result.exchanges[0]!.actual.response;
        expect(actual.status, server.output().slice(-2000)).toBe(HANDED_BACK_STATUS);
        return;
      }
      const result = await replayFixtureExchange(c.file, c.index, { ...options, compare });
      try {
        assertParity(result);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => /error|Error|at /.test(line)).slice(-25).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
