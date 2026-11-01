import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the WS-12b request specs: the affiliate redirect, and the JSON endpoints and mutations of reviews, offer codes,
// collaborators, affiliates, imported customers, commissions, calls, licenses and shipments. Each fixture is a login and a CSRF
// fetch (for the signed-in ones) followed by the request under test, which is the last exchange. A request Node hands back
// arrives at a stand-in for Rails, body and all; a fixture named `hands-a-...` asserts that.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["affiliate_redirect_parity_spec"].filter((dir) => existsSync(path.join(FIXTURES, dir)));
const ROUTE_FLAGS = ["nextjs_affiliate_redirect"].join(",");
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const jobKey = (job: { class: string; args: unknown; queue?: string }) => `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
function redisJobs(redis: Redis): JobsChannel {
  return {
    async reset() {
      /* the seeder flushes the database */
    },
    async drain(): Promise<RawJob[]> {
      const jobs: RawJob[] = [];
      for (const key of await redis.keys("bull:*")) {
        if ((await redis.type(key)) !== "hash") continue;
        const data = await redis.hget(key, "data");
        if (data === null) continue;
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as { class: string; args: unknown[]; queue: string; at?: number };
        jobs.push({ class: item.class, args: item.args, queue: item.queue, ...(item.at === undefined ? {} : { at: item.at }) });
      }
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // PaperTrail is off in the Rails specs; the goldens of each write pin the versions Node writes.
    "db.versions",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
    // Rails renders its debug exception page for a 404 in the test environment.
    "response.body",
  ],
};

// The value of an affiliate cookie is the second it was set; the case checks it is the second of the replay instead.
const AFFILIATE_COOKIE_PREFIX = "_gumroad_affiliate_id_";
const AFFILIATE_COOKIE_TOLERANCE_S = 120;
const affiliateCookieNames = (file: string): string[] => Object.keys(loadFixture(file).exchanges.at(-1)!.response?.cookies ?? {}).filter((name) => name.startsWith(AFFILIATE_COOKIE_PREFIX));

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec.replace(/_spec$/, "")}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("WS-12b parity", () => {
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
    const secureIdKey = testEnv("SECURE_EXTERNAL_ID__KEYS__1");
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      ...(secureIdKey ? { SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION: testEnv("SECURE_EXTERNAL_ID__PRIMARY_KEY_VERSION") ?? "1", SECURE_EXTERNAL_ID__KEYS__1: secureIdKey } : {}),
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST: process.env.ELASTICSEARCH_HOST ?? "http://localhost:9200",
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

  afterAll(async () => {
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await client?.$disconnect();
    process.env = saved;
  });

  const replayOptions = (file: string) => {
    const ignore = [...COMPARE.ignore, ...affiliateCookieNames(file).map((name) => `response.cookies.${name}.value`)];
    return {
      sql,
      redis: redisSeeder(redis),
      transport: httpTransport(server.baseUrl),
      interceptHttp: false,
      jobs: redisJobs(redis),
      rewriteRequest: (request: Parameters<typeof reencryptCookies>[0], loaded: Parameters<typeof reencryptCookies>[1], now: Date) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
      compare: { ignore },
    };
  };

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        if (name.includes("hands-a-")) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, replayOptions(file));
          const request = expected.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, replayOptions(file));
        assertParity(result);
        for (const cookie of affiliateCookieNames(file)) {
          const value = Number((result.exchanges.at(-1)!.actual.response?.cookies?.[cookie] as { value: string }).value);
          expect(Math.abs(value - Date.now() / 1000)).toBeLessThan(AFFILIATE_COOKIE_TOLERANCE_S);
        }
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
