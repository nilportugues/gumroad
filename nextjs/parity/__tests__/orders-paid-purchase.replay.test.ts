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
import { httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays spec/requests/orders_paid_purchase_parity_spec.rb: the last exchange of each fixture is sent to `next dev` with
// nextjs_orders_validations on. A paid order is not served in Node (docs/nextjs-rewrite/parity-debt.md, "paid purchase"), so every
// fixture is a hand-back: the stand-in Rails receives the request whole, and nothing is written before it does.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const DIR = path.join("parity/fixtures/requests", "orders_paid_purchase_parity_spec");
const ROUTE_FLAGS = "nextjs_orders_validations";
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
    "jobs.*.at",
    "response.json.line_items.*.content_url",
    "response.json.line_items.*.redirect_token",
    "db.url_redirects.inserted.*.token",
    "db.events.inserted.*.browser",
    "db.events.inserted.*.browser_fingerprint",
    "db.events.inserted.*.language",
    "http",
  ],
};

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set<string>();
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

// Mail and other ActiveJob jobs go out inside Sidekiq's JobWrapper; the recording keeps the wrapped job's class, arguments and queue.
function unwrap(item: RawJob): RawJob {
  const wrapped = item.args[0] as { job_class?: string; arguments?: unknown[]; queue_name?: string } | undefined;
  if (item.class !== "ActiveJob::QueueAdapters::SidekiqAdapter::JobWrapper" || !wrapped?.job_class) return item;
  return {
    ...item,
    class: wrapped.job_class,
    args: wrapped.arguments ?? [],
    queue: wrapped.queue_name ?? item.queue,
    activeJob: true,
  };
}

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
        const item = JSON.parse((JSON.parse(data) as { sidekiq: string }).sidekiq) as {
          class: string;
          args: unknown[];
          queue: string;
          at?: number;
        };
        if (IGNORED_JOBS.has(item.class)) continue;
        jobs.push({
          class: item.class,
          args: item.args,
          queue: item.queue,
          ...(item.at === undefined ? {} : { at: item.at }),
        });
      }
      // Jobs that still run in Ruby are pushed to Sidekiq's own lists (`queue:<name>`, `schedule`).
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
          if (!IGNORED_JOBS.has(item.class))
            jobs.push({
              class: item.class,
              args: item.args,
              queue: item.queue,
              ...(item.at === undefined ? {} : { at: item.at }),
            });
        }
      }
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at?: number };
        if (!IGNORED_JOBS.has(item.class))
          jobs.push({
            class: item.class,
            args: item.args,
            queue: item.queue,
            ...(item.at === undefined ? {} : { at: item.at }),
          });
      }
      return jobs.map(unwrap).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

const cases = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file.replace(/\.json$/u, ""),
            path.join(DIR, file),
            loadFixture(path.join(DIR, file)).exchanges.length - 1,
          ] as const,
      )
  : [];

describe.skipIf(!url)("Orders paid purchase", () => {
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
    server = await startNextServer({
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
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8012",
      ...(testEnv("DYNAMODB_TABLE_PREFIX") ? { DYNAMODB_TABLE_PREFIX: testEnv("DYNAMODB_TABLE_PREFIX")! } : {}),
      AWS_S3_ENDPOINT: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9010",
      ...(testEnv("AWS_ACCESS_KEY_ID") ? { AWS_ACCESS_KEY_ID: testEnv("AWS_ACCESS_KEY_ID")! } : {}),
      ...(testEnv("AWS_SECRET_ACCESS_KEY") ? { AWS_SECRET_ACCESS_KEY: testEnv("AWS_SECRET_ACCESS_KEY")! } : {}),
    });
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
    jobs: redisJobs(redis),
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
        if (!name.includes("-hands-"))
          throw new Error(`${name}: a paid order has to be handed back until its order is proven`);
        handedBack.length = 0;
        const handed = await replayFixtureExchange(fixture, index, replayOptions(file));
        const request = fixture.exchanges[index]!.request;
        expect(handedBack).toHaveLength(1);
        expect(handedBack[0]).toMatchObject({
          method: request.method,
          url: request.query ? `${request.path}?${request.query}` : request.path,
        });
        // Before any write and before any call to the processor.
        expect(Object.keys(handed.exchanges[0]!.actual.db)).toEqual([]);
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
