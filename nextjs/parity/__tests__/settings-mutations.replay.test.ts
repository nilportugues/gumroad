import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeAllRedis } from "@/server/infra/redis";

import type { JobsChannel, RawJob } from "../src/channels";
import { prismaExecutor, type SqlExecutor } from "../src/db";
import { ELASTICSEARCH_HOST, recreateIndex, reindexPurchases, replayIndexName } from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the form submissions of the third-party analytics and advanced settings: spec/requests/settings_mutations_signed_in_spec.rb. Each fixture is a
// login, a CSRF fetch and the request under test (a JSON body with the token in X-CSRF-Token, as Inertia sends it); the last one is
// replayed against `next dev` with the write flags on. The comparison covers the status, the redirect, the flash in the session
// cookie's place, every row written and every job enqueued.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = [
  "settings_mutations_signed_in_spec",
  "settings_payments_backtax_opt_in_spec",
  "settings_team_invitations_signed_in_spec",
  "settings_totp_signed_in_spec",
];
const ROUTE_FLAGS =
  "nextjs_settings_third_party_analytics_writes,nextjs_settings_advanced_writes,nextjs_settings_billing_writes,nextjs_settings_dismiss_ai_promo_writes,nextjs_settings_team_members_writes,nextjs_settings_payments_backtax_writes,nextjs_settings_team_invitations_writes,nextjs_settings_totp_writes";
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-settings";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker"]);
// Both are `lock: :until_executed`. The Rails run holds the locks its factories took before the request (the seller's creation pushed
// GenerateSubscribePreviewJob), and its recorder lists identical pushes of one request more than once; Node takes the lock as production
// does, so identical pushes collapse to one and a push the setup already made is not repeated.
const LOCKED_JOBS = new Set(["InvalidateProductCacheWorker", "GenerateSubscribePreviewJob"]);

function withoutLockedRepeats<T extends { class: string; args: unknown; queue?: string }>(jobs: T[]): T[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (job.class === "GenerateSubscribePreviewJob") return false;
    if (!LOCKED_JOBS.has(job.class)) return true;
    const key = jobKey(job);
    return !seen.has(key) && seen.add(key) !== undefined;
  });
}
const jobKey = (job: { class: string; args: unknown; queue?: string }) =>
  `${job.class} ${JSON.stringify(job.args)} ${job.queue ?? "default"}`;

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
      // Jobs of a class Ruby still runs sit in Sidekiq's own lists and schedule.
      for (const key of await redis.keys("queue:*")) {
        for (const raw of await redis.lrange(key, 0, -1)) {
          const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string };
          if (!IGNORED_JOBS.has(item.class)) jobs.push({ class: item.class, args: item.args, queue: item.queue });
        }
      }
      for (const raw of await redis.zrange("schedule", "0", "-1")) {
        const item = JSON.parse(raw) as { class: string; args: unknown[]; queue: string; at: number };
        if (!IGNORED_JOBS.has(item.class))
          jobs.push({ class: item.class, args: item.args, queue: item.queue, at: item.at });
      }
      return withoutLockedRepeats(jobs).sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
    },
  };
}

// Rails' versions are off in the test environment (PaperTrail.enabled = false), so the rows Node writes for them are not compared;
// models/concerns/paper-trail.test.ts and the golden of each write pin them.
const COMPARE = {
  ignore: [
    "response.headers.x-original-headers-class",
    "response.headers.cache-control",
    "response.headers.vary",
    "response.headers.link",
    "response.cookies.__profilin",
    "response.cookies.XSRF-TOKEN.value",
    "db.versions",
    "db.dashboard_nav_promotions.inserted.*.created_at",
    "db.dashboard_nav_promotions.inserted.*.updated_at",
    "db.users.updated.*.changes.updated_at",
    // The seed is stamped with the replay's clock, so a row Rails touched seconds after the factory made it is not touched in the same second.
    "db.third_party_analytics.updated.*.changes.updated_at",
    "db.custom_domains.updated.*.changes.updated_at",
    "db.blocked_customer_objects.updated.*.changes.updated_at",
    "db.billing_details.updated.*.changes.updated_at",
    "db.team_memberships.updated.*.changes.updated_at",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
  ],
};

const cases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec}: ${file.replace(/\.json$/, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

describe.skipIf(!url)("mutations of the settings pages", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  let es: ElasticsearchClient;
  let server: NextServer;
  // Stands in for Rails: a request Node hands back arrives here, body and all.
  let rails: Server;
  const handedBack: { method: string; url: string; body: string }[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    const [hostAndPort = "", db = "0"] = redisHost.split("/");
    const [host = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host, port: Number(port), db: Number(db) });
    es = new ElasticsearchClient({ node: ELASTICSEARCH_HOST });
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
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/m.exec(envTest)?.[1];
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
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

  // The first request to a route compiles it, and the time a write is stamped with is the replay's clock plus the compile: replay one
  // fixture before the first comparison.
  const replayOptions = (file: string, name: string) => ({
    sql,
    redis: {
      async reset(entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0], exchange?: unknown) {
        await redisSeeder(redis).reset(entries);
        if (!exchange) return;
        // The AI promo's eligibility sums the seller's sales in Elasticsearch.
        const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
        await recreateIndex(es, purchases);
        await reindexPurchases(es, purchases.name, sql);
      },
    },
    transport: httpTransport(server.baseUrl),
    interceptHttp: false,
    jobs: redisJobs(redis),
    rewriteRequest: (
      request: Parameters<typeof reencryptCookies>[0],
      loaded: Parameters<typeof reencryptCookies>[1],
      now: Date,
    ) => reencryptCookies(request, loaded, SECRET_KEY_BASE, now),
    // The test environment answers a 422 with its exception debug page, which the fixture does not keep.
    compare: /422|unknown-invitation/u.test(name) ? { ignore: [...COMPARE.ignore, "response.body"] } : COMPARE,
    file,
  });

  afterAll(async () => {
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

  it(
    "compiles the handler",
    async () => {
      for (const [name, file, index] of [
        cases.find(([name]) => name.includes("saves-the-pixel-ids")) ?? cases[0]!,
        cases.find(([name]) => name.includes("saves-the-ping-endpoint")) ?? cases[0]!,
      ]) {
        const { file: _file, ...options } = replayOptions(file, name);
        await replayFixtureExchange(file, index, options).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (_name, file, index) => {
      try {
        const fixture = loadFixture(file);
        // Rails and Node push in different orders across stores: both sides are compared sorted.
        const expected = fixture.exchanges[index]!;
        expected.jobs = withoutLockedRepeats([...(expected.jobs ?? [])]).sort((a, b) =>
          jobKey(a).localeCompare(jobKey(b)),
        );
        const { file: _file, ...options } = replayOptions(file, _name);
        if (_name.includes("hands-a-")) {
          // Whatever Node cannot prove goes to Rails whole, before its first write.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          const request = fixture.exchanges[index]!.request;
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: request.method, url: request.path });
          // A PUT or GET without a body reaches Rails with none.
          const parsed = (body: string) => (body === "" ? {} : (JSON.parse(body) as unknown));
          expect(parsed(handedBack[0]!.body)).toEqual(parsed(request.body ?? ""));
          // A GET navigation seeds the seller's nav promotions before the action runs, as Rails' own request would.
          expect(
            Object.keys(handed.exchanges[0]!.actual.db ?? {}).filter((name) => name !== "dashboard_nav_promotions"),
          ).toEqual([]);
          return;
        }
        const result = await replayFixtureExchange(fixture, index, options);
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
