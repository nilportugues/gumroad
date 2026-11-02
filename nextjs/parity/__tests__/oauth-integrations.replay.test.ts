import { createHmac } from "node:crypto";
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

// Replays the OAuth and integrations stream (WS-10b): spec/requests/social_callbacks_parity_spec.rb and its siblings. The last exchange of
// each fixture is sent to `next dev` with the stream's flags on; a stand-in Rails receives whatever Node hands back.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["social_callbacks_parity_spec", "connections_signed_in_spec", "oauth_applications_signed_in_spec"];
const ROUTE_FLAGS = "nextjs_social_callbacks,nextjs_connections_unlink,nextjs_oauth_applications";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
// The secrets spec/requests/social_callbacks_parity_spec.rb stubs.
const INSTAGRAM_APP_SECRET = "instagram-parity-secret";
const TIKTOK_CLIENT_SECRET = "tiktok-parity-secret";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.users.updated.*.changes.updated_at",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    // Random Doorkeeper tokens and client credentials; their format is pinned by models/oauth-application-writes.test.ts.
    "db.oauth_access_tokens.inserted.*.token",
    "db.oauth_access_grants.inserted.*.token",
    "db.oauth_applications.inserted.*.uid",
    "db.oauth_applications.inserted.*.secret",
    "response.json.token",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.oauth_applications.updated.*.changes.updated_at",
    "http",
  ],
};

// TikTok's signature carries the time it was made: the replay signs afresh against its own clock, keeping each fixture's intent
// (stale, forged, or valid).
function resignTiktok(request: { headers: Record<string, string>; body?: string | null }, name: string, now: Date) {
  const signature = request.headers["tiktok-signature"];
  if (signature === undefined) return request;
  const seconds = Math.floor(now.getTime() / 1000) - (name.includes("stale") ? 3600 : 0);
  const digest = name.includes("bad-signature") ? "0".repeat(64) : createHmac("sha256", TIKTOK_CLIENT_SECRET).update(`${seconds}.${request.body ?? ""}`).digest("hex");
  return { ...request, headers: { ...request.headers, "tiktok-signature": `t=${seconds},s=${digest}` } };
}

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("OAuth and integrations", () => {
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
        handedBack.push({ method: request.method ?? "", url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => rails.listen(0, "127.0.0.1", resolve));
    const railsPort = (rails.address() as { port: number }).port;
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      INSTAGRAM_APP_SECRET,
      TIKTOK_CLIENT_SECRET,
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
  }, FIRST_COMPILE_TIMEOUT_MS);

  const replayOptions = (name: string) => ({
    sql,
    redis: { reset: (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => redisSeeder(redis).reset(entries) },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    rewriteRequest: (request: Parameters<typeof reencryptCookies>[0], loaded: Parameters<typeof reencryptCookies>[1], now: Date) =>
      resignTiktok(reencryptCookies(request, loaded, SECRET_KEY_BASE, now) as never, name, now) as never,
    compare: COMPARE,
  });

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it("compiles the handlers", async () => {
    for (const [name, file, index] of cases.slice(0, 2)) await replayFixtureExchange(file, index, replayOptions(name)).catch(() => undefined);
  }, FIRST_COMPILE_TIMEOUT_MS);

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Whatever Node cannot prove goes to Rails whole, before its first write.
        if (/-hands-/u.test(name) || name.includes("not-an-object")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions(name));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        assertParity(await replayFixtureExchange(fixture, index, replayOptions(name)));
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
