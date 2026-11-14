import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/purchase_invoice_form_parity_spec.rb and purchases_product_parity_spec.rb (the GET pages whose guards run in Node; the purchase product page and the invoice form render in Node): the last exchange of each fixture is sent to `next dev` with
// the flags on; a stand-in Rails receives whatever Node hands back.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIRS = ["purchase_invoice_form_parity_spec", "purchases_product_parity_spec"].map((spec) =>
  path.join("parity/fixtures/requests", spec),
);
const ROUTE_FLAGS = "nextjs_purchase_invoices,nextjs_purchase_product_guards";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "http",
    // Next.js owns the per-response random values of an Inertia page.
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.inertia.props._inertia_meta.1.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.2.content",
    "response.json.props._inertia_meta.1.content",
  ],
};

const cases = DIRS.flatMap((dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map(
          (file) =>
            [
              file.replace(/\.json$/u, ""),
              path.join(dir, file),
              loadFixture(path.join(dir, file)).exchanges.length - 1,
            ] as const,
        )
    : [],
);

describe.skipIf(!url)("Purchase pages guards", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    rails = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        handedBack.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    // The invoice fixtures seed the purchase as "<now-15543h>", so its printed date is right only on the recording day; PARITY_PIN_NOW
    // (inside 2026-11-12T15:00Z..2026-11-13T15:00Z) moves both the seeding and the server clock there.
    const pinMs = process.env.PARITY_PIN_NOW
      ? Date.parse(process.env.PARITY_PIN_NOW) - (performance.timeOrigin + performance.now())
      : 0;
    server = await startNextServer({
      ...(process.env.PARITY_PIN_NOW
        ? {
            NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
            PARITY_CLOCK_OFFSET_MS: String(Math.round(pinMs)),
          }
        : {}),
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      ...(testEnv("STRIPE_PUBLIC_KEY_TEST") ? { STRIPE_PUBLIC_KEY_TEST: testEnv("STRIPE_PUBLIC_KEY_TEST")! } : {}),
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
    if (process.env.PARITY_PIN_NOW)
      vi.useFakeTimers({ now: Date.parse(process.env.PARITY_PIN_NOW), toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  // The invoice form prints the purchase's date, and the spec made that purchase at 2025-02-03T04:05:06Z: recorded as `<now-15543h>`, it
  // lands on the next day once the replay's clock is more than a day past the recording. Only the seed resolves against the pinned instant.
  const PINNED_CLOCKS: [fragment: string, recordedAt: string][] = [
    ["renders-the-invoice-form", "2026-11-12T19:05:06Z"],
  ];

  const replayOptions = (file: string, name = "") => {
    const pinned = PINNED_CLOCKS.find(([fragment]) => name.includes(fragment));
    const ignore = [...COMPARE.ignore];
    // Rails' debug page for a 404 is not recorded and sets the profiler cookie.
    if (readFileSync(file, "utf8").includes("rails exception debug page"))
      ignore.push("response.cookies", "response.body", "response.json");
    return {
      ...replayOptionsFor({ ignore }),
      ...(pinned ? { driftDates: false, seedClock: new Date(pinned[1]) } : {}),
    };
  };

  const replayOptionsFor = (compare: { ignore: string[] }) => ({
    sql,
    redis: {
      reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries),
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    compare,
  });

  afterAll(async () => {
    await server.stop();
    rails.close();
    await closeAllRedis();
    await redis.quit();
    await client.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it(
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases.slice(0, 2))
        await replayFixtureExchange(file, index, replayOptions(file)).catch(() => undefined);
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Whatever Node cannot prove goes to Rails whole, before its first write.
        if (name.includes("-hands-")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions(file));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, replayOptions(file, name)));
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
