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
import {
  bulkIndex,
  ELASTICSEARCH_HOST,
  recreateIndex,
  reindexProducts,
  reindexPurchases,
  replayIndexName,
  seededDocuments,
} from "../src/elasticsearch";
import { loadFixture } from "../src/fixture";
import { startNextServer, type NextServer } from "../src/next-server";
import { fillFirstThrottle, rackAttackCounters } from "../src/rack-attack";
import { assertParity, httpTransport, replayFixtureExchange } from "../src/replay";
import { reencryptCookies, redisSeeder } from "../src/session";

// Replays the throttled pages and writes Node counts itself: spec/requests/rack_attack_routes_parity_spec.rb. Each request comes from a non-local address
// (localhost is safelisted by Rack::Attack). An example that reads the counters compares them with the keys Rack::Attack wrote; "answers 429" puts
// the first throttle at its limit before the request, as the recording did by calling Rack::Attack in a loop; "hands ..." must reach Rails whole and
// leave no count behind, because Rails counts it again.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST ?? "127.0.0.1:6379/14";
const FIXTURES = "parity/fixtures/requests";
const SPECS = ["rack_attack_routes_parity_spec"];
const ROUTE_FLAGS = [
  "nextjs_discover",
  "nextjs_storefront_profile",
  "nextjs_product_page",
  "nextjs_auth_signup",
  "nextjs_route_redirects",
  "nextjs_acme_challenge",
  "nextjs_settings_totp_writes",
  "nextjs_settings_passkeys_writes",
  "nextjs_marketing_actions",
].join(",");
const PERIOD_SECONDS = 60;
const ES_INDEX_SUFFIX = process.env.PARITY_ES_INDEX_SUFFIX ?? "-parity-rack-attack";
const FIRST_COMPILE_TIMEOUT_MS = 300_000;
const SECRET_KEY_BASE = "parity-replay-secret-key-base";
const envTest = readFileSync(path.join(process.cwd(), "..", ".env.test"), "utf8");
const stripeKey = /^STRIPE_PUBLIC_KEY_TEST=(.+)$/mu.exec(envTest)?.[1];
const testEnv = (name: string) => new RegExp(`^${name}="?([^"\\n]+)"?$`, "mu").exec(envTest)?.[1];

// Jobs Node enqueues are BullMQ jobs wrapping the Sidekiq item; the key of a job is what its Sidekiq twin is compared by.
// The product reindex of a post attached to a product asks Elasticsearch for a document the replay does not hold, and Node then
// queues the fallback job Rails never needed.
const IGNORED_JOBS = new Set(["SendToElasticsearchWorker"]);
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
      return jobs.sort((a, b) => jobKey(a).localeCompare(jobKey(b)));
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
    "db.links.updated.*.changes.updated_at",
    // Delayed jobs are scheduled seconds ahead of the clock, which the replay normalizes to the nearest bucket.
    "jobs.*.at",
    "http",
  ],
};

const allCases = SPECS.flatMap((spec) => {
  const dir = path.join(FIXTURES, spec);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        [
          `${spec}: ${file.replace(/\.json$/u, "")}`,
          path.join(dir, file),
          loadFixture(path.join(dir, file)).exchanges.length - 1,
        ] as const,
    );
});

const cases = allCases;

// The rule names ("counts") or the refused rule ("answers 429") each example is about, by the words of its file name. A counter key is
// `rack::attack:<window>:<rule>:<discriminator>`; a tier of a rule is `<rule>/<level>`.
const tiers = (rule: string, levels: number) => [
  rule,
  ...Array.from({ length: levels - 1 }, (_, i) => `${rule}/${i + 2}`),
];
const COUNTED_RULES: [RegExp, string[]][] = [
  [/get-discover-counts/u, tiers("/ip:/discover", 5)],
  [/get-on-a-seller-host-counts/u, tiers("/ip:/", 5)],
  [/get-signup-counts/u, tiers("/ip:/signup", 5)],
  [/get-purchases-counts/u, [...tiers("/ip:/purchases", 5), "/ip/period:/purchases"]],
  [/acme-challenge-token-counts/u, ["/ip/period:(?-mix:\\A\\/\\.well-known\\/acme-challenge\\/)"]],
  [/settings-totp-confirm-counts/u, tiers("/params:/settings/totp/confirm:post", 6)],
  [/registration-options-counts/u, tiers("/params:/settings/passkeys/registration_options:POST", 6)],
  [/execute-json-counts/u, tiers("/params:/products/:id/marketing_actions/:id/execute:POST", 6)],
  [/params-rack-cannot-parse-counts/u, [...tiers("invalid_params", 7), ...tiers("/ip:/discover", 5)]],
];

// The 429 of a rule keyed by the signed-in user: the recording called `Rack::Attack.cache.count` for the user ten (or five) times; the replay
// sets the user's counter, found as the only user row of the seed, to the same value.
const USER_RULE_TRIPS: [RegExp, string, number][] = [
  [/settings-totp-confirm-answers-429/u, "/params:/settings/totp/confirm:post", 10],
  [/settings-passkeys-answers-429/u, "/params:/settings/passkeys:POST", 10],
  [/execute-json-answers-429/u, "/params:/products/:id/marketing_actions/:id/execute:POST", 5],
];

describe.skipIf(!url)("Throttled routes counted in Node", () => {
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
    process.env.DATABASE_URL = url;
    process.env.ELASTICSEARCH_HOST = ELASTICSEARCH_HOST;
    process.env.ES_INDEX_SUFFIX = ES_INDEX_SUFFIX;
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
    const obfuscateKey = /^OBFUSCATE_IDS_CIPHER_KEY=(.+)$/mu.exec(envTest)?.[1];
    server = await startNextServer({
      RAILS_ENV: "test",
      OBFUSCATE_IDS_CIPHER_KEY: obfuscateKey ?? "",
      OBFUSCATE_IDS_NUMERIC_CIPHER_KEY: "0",
      NEXTJS_ROUTE_FLAGS: ROUTE_FLAGS,
      // The storefront root is the signed-out page; the examples that carry a session still go through the gate.
      NEXTJS_ASSUME_SIGNED_OUT: "no-cookie",
      ELASTICSEARCH_HOST,
      ES_INDEX_SUFFIX,
      // The signup rule is registered only in production (rack_attack.rb); the recording loaded it as production.
      RACK_ATTACK_PRODUCTION_RULES: "1",
      ...(stripeKey ? { STRIPE_PUBLIC_KEY_TEST: stripeKey } : {}),
      RAILS_ORIGIN: `http://127.0.0.1:${railsPort}`,
      SECRET_KEY_BASE,
      MOBILE_TOKEN: testEnv("MOBILE_TOKEN") ?? "",
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
  // Runs once the seeder has reset Redis, ahead of the request under test.
  let afterRedisReset: (() => Promise<void>) | undefined;
  const replayOptions = (file: string) => ({
    sql,
    redis: {
      reset: async (
        entries: Parameters<ReturnType<typeof redisSeeder>["reset"]>[0],
        exchange?: Parameters<typeof seededDocuments>[0],
        now?: Date,
      ) => {
        await redisSeeder(redis).reset(entries);
        if (exchange && now) {
          // The discover and storefront pages read the products index, which the seeded rows rebuild.
          const purchases = { model: "Purchase", name: replayIndexName("purchases", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, purchases);
          await reindexPurchases(es, purchases.name, sql);
          const products = { model: "Link", name: replayIndexName("products", ES_INDEX_SUFFIX) } as const;
          await recreateIndex(es, products);
          await reindexProducts(es, products.name, sql);
          const views = {
            model: "ProductPageView",
            name: replayIndexName("product_page_views", ES_INDEX_SUFFIX),
          } as const;
          await recreateIndex(es, views);
          await bulkIndex(
            es,
            views.name,
            seededDocuments(exchange, "ProductPageView", now).map((body) => ({ body })),
          );
        }
        await afterRedisReset?.();
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
    // The pages are compared prop by prop by their own replays (discover, storefront-profile, auth-pages): this one proves the count and the 429.
    compare: {
      ignore: [...COMPARE.ignore, "response.body", "response.json", "response.inertia", "response.cookies"],
    },
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
    "compiles the handlers",
    async () => {
      for (const [, file, index] of cases.filter(([name]) => /-counts-/u.test(name))) {
        const { file: _file, ...options } = replayOptions(file);
        await replayFixtureExchange(file, index, options).catch(() => undefined);
      }
    },
    FIRST_COMPILE_TIMEOUT_MS,
  );

  it.each(cases)(
    "%s",
    async (name, file, index) => {
      try {
        afterRedisReset = undefined;
        const fixture = loadFixture(file);
        const expected = fixture.exchanges[index]!;
        const { file: _file, ...options } = replayOptions(file);
        if (/-hands-/u.test(name)) {
          // A valid update goes to Rails whole; Rails counts it, so what Node counted ahead of the hand-back is taken back.
          handedBack.length = 0;
          const handed = await replayFixtureExchange(fixture, index, options);
          expect(handedBack).toHaveLength(1);
          expect(handedBack[0]).toMatchObject({ method: expected.request.method });
          expect(new URL(handedBack[0]!.url, "http://localhost").pathname).toBe(expected.request.path);
          expect(Object.keys(handed.exchanges[0]!.actual.db ?? {})).toEqual([]);
          expect(Object.values(await rackAttackCounters(redis)).every((count) => count === 0)).toBe(true);
          return;
        }
        // The recording filled the throttle by calling Rack::Attack in a loop; the replay puts the same counter at its limit.
        const trips = name.includes("-answers-429-");
        const userRule = USER_RULE_TRIPS.find(([pattern]) => pattern.test(name));
        if (trips) {
          handedBack.length = 0;
          afterRedisReset = async () => {
            if (userRule === undefined) {
              await fillFirstThrottle(redis, expected.request);
              return;
            }
            const users = expected.seed.tables.users as unknown as { rows: { id: number }[] };
            const bucket = Math.trunc(Date.now() / 1000 / PERIOD_SECONDS);
            await redis.set(
              `rack::attack:${bucket}:${userRule[1]}:${users.rows[0]!.id}`,
              userRule[2],
              "EX",
              PERIOD_SECONDS * 2,
            );
          };
        }
        const result = await replayFixtureExchange(fixture, index, {
          ...options,
          compare: { ignore: [...options.compare.ignore, ...(trips ? ["response.headers.retry-after"] : [])] },
        });
        assertParity(result);
        if (trips) {
          const retryAfter = Number(result.exchanges[0]!.actual.response.headers["retry-after"]);
          expect(retryAfter).toBeGreaterThan(0);
          expect(retryAfter).toBeLessThanOrEqual(64);
          expect(handedBack).toHaveLength(0);
        } else {
          const counted = COUNTED_RULES.find(([pattern]) => pattern.test(name));
          expect(counted, `${name} has no expected rules`).toBeDefined();
          // `<rule>:<discriminator>` after the window: the rule is whichever expected name the key starts with.
          const counters = Object.entries(await rackAttackCounters(redis)).map(
            ([key, count]) => [key.replace(/^rack::attack:\d+:/u, ""), count] as const,
          );
          expect(counters.every(([, count]) => count === 1)).toBe(true);
          const rules = counters.map(([key]) => counted![1].find((rule) => key.startsWith(`${rule}:`)));
          expect(rules.sort()).toEqual([...counted![1]].sort());
        }
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
