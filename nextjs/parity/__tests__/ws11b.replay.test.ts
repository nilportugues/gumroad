import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import type { JobsChannel, RawJob } from "../src/channels";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the WS-11b storefront and audience leftovers (the specs listed in SPECS), with the same method as dashboard-json.replay.test.ts: each fixture is a login,
// a CSRF fetch and the request under test, and only the last is replayed against `next dev` with the route flags on. A request the
// port hands back must reach the stand-in Rails with its body, before anything is written.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["utm_links_mutations_signed_in_spec", "wishlist_items_mutations_signed_in_spec", "post_views_signed_in_spec"];
const ROUTE_FLAGS = ["nextjs_utm_links_writes", "nextjs_utm_link_tracking", "nextjs_wishlist_items_writes", "nextjs_wishlist_unsubscribe", "nextjs_post_views"].join(",");
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.link",
    // Next.js adds its RSC headers to Vary; checked below without them.
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    "db.versions",
    // Stamped by a handler that may still be compiling its first query when the request lands.
    "db.utm_links.inserted.*.created_at",
    "db.utm_links.inserted.*.updated_at",
    "db.utm_links.updated.*.changes.updated_at",
    "db.wishlist_followers.inserted.*.created_at",
    "db.wishlist_followers.inserted.*.updated_at",
    "db.wishlist_followers.updated.*.changes.updated_at",
    "db.wishlist_followers.updated.*.changes.deleted_at",
    "db.wishlist_products.inserted.*.created_at",
    "db.wishlist_products.inserted.*.updated_at",
    "db.wishlist_products.updated.*.changes.updated_at",
    "db.wishlist_products.updated.*.changes.deleted_at",
    "db.wishlists.updated.*.changes.updated_at",
    "http",
    "jobs.*.at",
  ],
};

const NEXT_VARY = /(?:rsc|next-router-state-tree|next-router-prefetch|next-router-segment-prefetch)(?:, )?/g;
const withoutNextVary = (vary: unknown) => (typeof vary === "string" ? vary.replace(NEXT_VARY, "") : vary);
const HANDED_BACK = /hands-a-|through-rails/;

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; jobs of a class Ruby still runs sit in Sidekiq's own lists and schedule.
const jobKey = (job: { class: string; args: unknown; queue?: string }) => `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;
const redisJobs = (redis: Redis): JobsChannel => ({
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
    for (const key of await redis.keys("queue:*")) {
      for (const raw of await redis.lrange(key, 0, -1)) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
        jobs.push({ class: item.class, args: item.args, queue: item.queue });
      }
    }
    for (const raw of await redis.zrange("schedule", "0", "-1")) {
      const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at: number };
      jobs.push({ class: item.class, args: item.args, queue: item.queue, at: item.at });
    }
    return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
  },
});

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [`${spec}: ${file.replace(/\.json$/, "")}`, path.join(dir, file), loadFixture(path.join(dir, file)).exchanges.length - 1] as const);
});

describe.skipIf(!url)("ws11b storefront and audience", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
      OBFUSCATE_IDS_CIPHER_KEY: testEnv("OBFUSCATE_IDS_CIPHER_KEY") ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
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
    await new Promise((resolve) => rails?.close(resolve));
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  const options = (name = "") => ({
    sql,
    redis: {
      reset: async (entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0]) => {
        await redisSeeder(redis).reset(entries);
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (request: Parameters<typeof reencryptCookies>[0], loaded: Parameters<typeof reencryptCookies>[1], now: Date) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    // The 404 page body is not recorded.
    compare: { ignore: [...COMPARE.ignore, ...(name.includes("404") ? ["response.body", "response.json", "response.headers.content-type"] : []), ...(name.includes("generates-a-permalink") ? ["db.utm_links.inserted.*.permalink"] : [])] },
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The first request down a code path compiles what it imports, which would age the seeded timestamps past the
  // replayer's tolerance. One warm-up per route is not enough: a 404 never reaches the modules a delete loads.
  it("compiles the handlers", async () => {
    for (const [, file, index] of cases) await replayFixtureExchange(file, index, options()).catch(() => undefined);
  }, FIRST_COMPILE_TIMEOUT_MS * 3);

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const recorded = fixture.exchanges[index]!;
        recorded.jobs = [...(recorded.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        if (HANDED_BACK.test(name)) {
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options(name));
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method });
          expect(decodeURIComponent(handedBack[0]!.url.split("?")[0]!)).toBe(decodeURIComponent(request.path.split("?")[0]!));
          if (request.body) expect(JSON.parse(handedBack[0]!.body)).toEqual(JSON.parse(request.body));
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options(name));
        assertParity(result);
        const { expected, actual } = result.exchanges[0]!;
        expect(withoutNextVary(actual.response.headers.vary)).toBe(expected.response.headers.vary);
      } catch (error) {
        const logs = server.output().split("\n").filter((line) => !line.startsWith("Next.js includes")).slice(-40).join("\n");
        throw new Error(`${(error as Error).message}\n--- server ---\n${logs}`);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );
});
