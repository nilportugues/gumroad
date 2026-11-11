import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { redisSeeder } from "../src/session";

// Replays spec/requests/api/v2/sales_parity_spec.rb: GET /v2/sales/summary, PUT /v2/sales/:id/revoke_access and undo_revoke_access
// (served by Node), and PUT refund and mark_as_shipped (the 404 is Node's, anything else is handed back). The spec froze the clock at
// PARITY_NOW, so the replay moves its own clock and the server's to that instant: the summary's default range and its hour and week
// buckets are made of dates, and a DST change on the recorded week must stay on it. The purchases index is rebuilt from the seeded
// rows before every exchange. A fixture whose name has `hands-back` asserts that the request reached the Rails stand-in and wrote nothing.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const SPEC = "sales_parity_spec";
const FIXTURES = path.join("parity/fixtures/requests/api/v2", SPEC);
const PARITY_NOW = Date.UTC(2026, 10, 2, 15, 0, 0);
// The server's clock is the real clock plus a fixed offset. The worker's fake Date is re-anchored to that same formula before every
// example: `shouldAdvanceTime` ticks 20ms per timer fire however late the fire is, so on a loaded host it falls behind the server.
// performance is not faked, so it reads the real clock.
const realNow = () => performance.timeOrigin + performance.now();
let clockOffset = 0;
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as RawJob;
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    // Next.js owns Vary on what it serves (its RSC cache keys).
    "response.headers.vary",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    // PaperTrail is off in the Rails specs; the unit tests of the write pin the versions Node writes.
    "db.versions",
    // travel_to leaves the sale's updated_at on the second the factory stamped it, so Rails records no change; Node's clock keeps running.
    "db.purchases.updated.*.changes.updated_at",
    "jobs.*.at",
    "http",
    // Rails renders its debug exception page for a 404 in the test environment.
    "response.body",
  ],
};

const cases = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/u, ""),
            path.join(FIXTURES, file),
            loadFixture(path.join(FIXTURES, file)).exchanges.length - 1,
          ] as const,
      )
  : [];

describe.skipIf(!url)("API v2 sales parity", () => {
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
    clockOffset = PARITY_NOW - realNow();
    server = await startNextServer({
      RAILS_ENV: "test",
      NODE_OPTIONS: `--require ${path.resolve(import.meta.dirname, "..", "src", "fixed-clock-preload.cjs")}`,
      PARITY_CLOCK_OFFSET_MS: String(clockOffset),
      OBFUSCATE_IDS_CIPHER_KEY: /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1] ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: "nextjs_api_v2_sales",
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      DATABASE_URL: url!,
      REDIS_HOST: redisHost,
      SIDEKIQ_REDIS_HOST: redisHost,
      RACK_ATTACK_REDIS_HOST: redisHost,
      JOBS_REDIS_URL: `redis://${redisHost}`,
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
    // Only Date moves, and it keeps running from the frozen instant.
    vi.useFakeTimers({ now: realNow() + clockOffset, toFake: ["Date"], shouldAdvanceTime: true });
  }, FIRST_COMPILE_TIMEOUT_MS);

  beforeEach(() => {
    vi.setSystemTime(realNow() + clockOffset);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await server?.stop();
    rails?.close();
    await closeAllRedis();
    await redis?.quit();
    await es?.close();
    await client?.$disconnect();
    process.env = saved;
  });

  it("finds the fixtures", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  const replay = (fixture: Parameters<typeof replayFixtureExchange>[0], index: number) =>
    replayFixtureExchange(fixture, index, {
      sql,
      redis: {
        async reset(entries, exchange, now) {
          await redisSeeder(redis).reset(entries);
          if (!exchange || !now) return;
          const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, purchases);
          await reindexPurchases(es, purchases.name, sql);
        },
      },
      // The clocks already sit on the recorded day; drifting the fixture's dates too would shift them twice.
      driftDates: false,
      transport: httpTransport(server.baseUrl),
      interceptHttp: false,
      jobs: redisJobs(redis),
      compare: COMPARE,
    });

  // The first request to a route compiles it, which would age the seeded timestamps past the replayer's tolerance.
  it(
    "warms up the routes",
    async () => {
      const warmed = new Set<string>();
      for (const [, file, index] of cases) {
        const { method, path: requestPath } = loadFixture(file).exchanges.at(index)!.request;
        const route = `${method} ${requestPath.replace(/[?].*/u, "").replace(/\/[^/]*(?:==|[a-z]\d)[^/]*\//u, "/:id/")}`;
        if (warmed.has(route)) continue;
        warmed.add(route);
        await replay(file, index).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS * 3,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        expected.jobs = [...(expected.jobs ?? [])].sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
        handedBack.length = 0;
        const result = await replay(fixture, index);
        if (name.includes("hands-back")) {
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: expected.request.method, url: expected.request.path });
          expect(Object.keys(result.exchanges[0]!.actual.db ?? {})).toEqual([]);
          return;
        }
        expect(handedBack).toHaveLength(0);
        assertParity(result);
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
