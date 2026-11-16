import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { playerGrantExpiresAt } from "@/server/auth/player-grant";
import { closeAllRedis } from "@/server/infra/redis";

import { compareExchange, formatDifferences } from "../src/compare";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays ProductBuildPlayerFilesController and the public demo's controllers (ProductBuildDemosController, ProductBuildDemoFilesController).
// The demo page's 200 examples ("renders ...") are not served from Node: demo.test.ts proves their props. The last exchange of each fixture is sent to `next dev` with the
// routes' flag on; a stand-in Rails receives whatever Node hands back.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "product_build_player_files_parity_spec",
  "product_build_demos_parity_spec",
  "product_build_demo_files_parity_spec",
].filter((dir) => existsSync(path.join(FIXTURES, dir)));
const ROUTE_FLAGS = "nextjs_product_build_player_files,nextjs_product_build_demos";
const NOT_REPLAYED = /^product-build-demo-page-renders-/u;
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];
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
    // insert_all leaves these to the database clock, which is not UTC on every machine.
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    // Per-response random values of a rendered page.
    "response.inertia.props.csp_nonce",
    "response.inertia.props.authenticity_token",
    "response.inertia.props._inertia_meta.2.content",
    "response.inertia.props._inertia_meta.1.content",
    "response.json.props.csp_nonce",
    "response.json.props.authenticity_token",
    "response.json.props._inertia_meta.1.content",
    "response.json.props._inertia_meta.2.content",
  ],
};

// X-Amz-Date, the credential scope's date, the expiry and the signatures depend on the second a URL was signed at.
const mask = (value: unknown): unknown => {
  if (typeof value === "string")
    return value
      .replace(/X-Amz-Date=\d{8}T\d{6}Z/gu, "X-Amz-Date=<signed-at>")
      .replace(/(X-Amz-Credential=[^&]*?)%2F\d{8}%2F/gu, "$1%2F<date>%2F")
      .replace(/X-Amz-Signature=[0-9a-f]{64}/gu, "X-Amz-Signature=<signature>")
      .replace(/(?<![-\w])Expires=\d{10}/gu, "Expires=<expires>")
      .replace(/(?<![-\w])Signature=[A-Za-z0-9+/=_~-]+/gu, "Signature=<signature>");
  if (Array.isArray(value)) return value.map(mask);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]));
  return value;
};

// The objects the Rails spec put in storage, under the prefix each request's grant names.
const SPEC_BUCKET = "gumroad-specs";
const FILES: Record<string, [string, string]> = {
  "game.js": ["console.log(1)", "text/javascript"],
  "style.css": ["body { margin: 0 }", "text/css"],
  "engine.wasm": ["\0asm", "application/wasm"],
  "art/logo.svg": ["<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"],
  "data.xml": ["<data/>", "application/xml"],
};
// A player grant is valid for 12 hours from the instant Rails issued it, so the replay's clock is pinned inside that window.
const GRANT_WINDOW_MS = 12 * 60 * 60 * 1000;
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;
process.env.SECRET_KEY_BASE = "parity-replay-secret-key-base";

const grantsOf = () =>
  SPECS.flatMap((spec) =>
    readdirSync(path.join(FIXTURES, spec))
      .filter((file) => file.endsWith(".json") && !NOT_REPLAYED.test(file))
      .map((file) => {
        const requestPath = loadFixture(path.join(FIXTURES, spec, file))
          .exchanges.at(-1)!
          .request.path.split("/");
        return requestPath[1] === "demo" ? requestPath[3] : requestPath[4];
      })
      .filter((grant): grant is string => grant !== undefined),
  );

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !NOT_REPLAYED.test(file))
    .map(
      (file) =>
        [
          `${spec.replace(/_parity_spec$/u, "")}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

describe.skipIf(!url)("product build player files", () => {
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
    const expiries = grantsOf().flatMap((grant) => playerGrantExpiresAt(grant) ?? []);
    clockOffset = Math.min(...expiries.map((expiry) => expiry.getTime())) - GRANT_WINDOW_MS + 1000 - realNow();
    const s3 = new S3Client({
      region: "us-east-1",
      endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      forcePathStyle: true,
      credentials: {
        accessKeyId: testEnv("AWS_ACCESS_KEY_ID") ?? "",
        secretAccessKey: testEnv("AWS_SECRET_ACCESS_KEY") ?? "",
      },
    });
    for (const grant of grantsOf()) {
      const prefix = (await import("@/server/auth/player-grant")).verifiedPlayerGrantUnchecked(grant);
      if (prefix === null) continue;
      for (const [name, [body, type]] of Object.entries(FILES))
        await s3.send(
          new PutObjectCommand({ Bucket: SPEC_BUCKET, Key: `${prefix}/${name}`, Body: body, ContentType: type }),
        );
    }
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      ...(testEnv("CLOUDFRONT_PRIVATE_KEY")
        ? { CLOUDFRONT_PRIVATE_KEY: testEnv("CLOUDFRONT_PRIVATE_KEY")!.replaceAll("\\n", "\n") }
        : {}),
      ...(testEnv("CLOUDFRONT_KEYPAIR_ID") ? { CLOUDFRONT_KEYPAIR_ID: testEnv("CLOUDFRONT_KEYPAIR_ID")! } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = (file: string) => {
    const ignore = [...COMPARE.ignore];
    // Rails' debug page for a 404 is not recorded and sets the profiler cookie.
    if (readFileSync(file, "utf8").includes("rails exception debug page"))
      ignore.push("response.cookies", "response.body", "response.json");
    return replayOptionsFor({ ignore });
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

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
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
        if (/-hands-an?-/u.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions(file));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({
            method: request.method,
            url: request.query ? `${request.path}?${request.query}` : request.path,
          });
          // A signed-in page seeds the dashboard nav rows in the filters, as Rails does, before the action hands back.
          expect(
            Object.keys(handed.exchanges[0]!.actual.db).filter((table) => table !== "dashboard_nav_promotions"),
          ).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, replayOptions(file));
        const [{ expected: want, actual }] = result.exchanges as [(typeof result.exchanges)[number]];
        const differences = compareExchange(mask(want) as typeof want, mask(actual) as typeof actual, {
          ...replayOptions(file).compare,
          ...(fixture.sessionCookie ? { sessionCookie: fixture.sessionCookie } : {}),
        });
        if (differences.length > 0) throw new Error(`${fixture.example}\n${formatDifferences(differences)}`);
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
