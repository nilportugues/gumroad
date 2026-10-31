import { readdirSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetRailsCacheForTesting } from "@/server/cache/rails-cache";
import { defaultHealthcheckDeps, REDIS_KEYS, type HealthcheckDeps, setHealthcheckDepsForTesting } from "@/server/controllers/healthcheck";
import { closeAllRedis, getRedis } from "@/server/infra/redis";
import { setSqlClient } from "@/server/models/sql";
import { InvalidRequestError } from "@/server/stripe/errors";

import { prismaExecutor, type SqlExecutor } from "../src/db";
import { loadFixture } from "../src/fixture";
import { assertParity, replayFixture, routeHandlers } from "../src/replay";

// Replays every fixture recorded from spec/controllers/healthcheck_controller_spec.rb against the
// route handlers. Needs a disposable MySQL database and Redis DB 14:
//   PARITY_DATABASE_URL=mysql://root:password@127.0.0.1:3306/gumroad_ws41 PARITY_REDIS_HOST=127.0.0.1:6379/14 npm run parity
// Redis is not part of a fixture, so each example's Redis state (and the Sidekiq/Stripe stubs the
// spec installs) is rebuilt here from the spec's `before` blocks.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST;
const FIXTURES = "parity/fixtures/controllers/healthcheck_controller_spec";

const ROUTES: Record<string, () => Promise<Parameters<typeof routeHandlers>[0]>> = {
  "/healthcheck": () => import("@/app/healthcheck/route"),
  "/healthcheck/sidekiq": () => import("@/app/healthcheck/sidekiq/route"),
  "/healthcheck/payouts": () => import("@/app/healthcheck/payouts/route"),
  "/healthcheck/long_running_jobs": () => import("@/app/healthcheck/long_running_jobs/route"),
  "/healthcheck/paypal_balance": () => import("@/app/healthcheck/paypal_balance/route"),
  "/healthcheck/stripe_balance": () => import("@/app/healthcheck/stripe_balance/route"),
  "/healthcheck/purchases": () => import("@/app/healthcheck/purchases/route"),
  "/healthcheck/apple_pay_domain": () => import("@/app/healthcheck/apple_pay_domain/route"),
  "/healthcheck/abandoned_cart_emails": () => import("@/app/healthcheck/abandoned_cart_emails/route"),
};

const HOUR = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);
// (IN_FLIGHT_ENTRY_TTL + 1.minute).ago.to_i
const staleScore = (ttlHours: number) => nowSeconds() - ttlHours * HOUR - 60;

type Setup = (redis: Redis) => Promise<Partial<HealthcheckDeps> | void>;

const sizes = (critical: number, defaultQueue: number, retries: number): Partial<HealthcheckDeps> => ({
  sidekiqQueueSize: async (name) => (name === "critical" ? critical : name === "default" ? defaultQueue : 0),
  sidekiqRetrySetSize: async () => retries,
});
const stagingBranch = (register: HealthcheckDeps["registerApplePayDomain"]): Partial<HealthcheckDeps> => ({
  applePayApplicable: () => true,
  registerApplePayDomain: register,
});

// Keyed by the recorded example's description.
const SETUPS: [RegExp, Setup][] = [
  // The critical and default shared examples share a description, so the default queue's recording
  // is the one kept; the queue doubles answer the limit -1/+1 for it and 0 elsewhere.
  [/Sidekiq queues .*queue queues returns HTTP success/, async () => sizes(0, 299_999, 0)],
  [/Sidekiq queues .*queue queues returns HTTP service_unavailable/, async () => sizes(0, 300_001, 0)],
  [/retry set .*returns HTTP success/, async () => sizes(0, 0, 19_999)],
  [/retry set .*returns HTTP service_unavailable/, async () => sizes(0, 0, 20_001)],
  [/'payouts' when a payout batch is in flight/, async (r) => void (await r.zadd(REDIS_KEYS.payoutBatchInFlight, nowSeconds(), "job-token"))],
  [/'payouts' when the only entries are older/, async (r) => void (await r.zadd(REDIS_KEYS.payoutBatchInFlight, staleScore(3), "dead-job-token"))],
  [
    /'payouts' when a stale entry sits alongside/,
    async (r) => void (await r.zadd(REDIS_KEYS.payoutBatchInFlight, staleScore(3), "dead-job-token", nowSeconds(), "live-job-token")),
  ],
  [/'long_running_jobs' when a long-running job is in flight/, async (r) => void (await r.zadd(REDIS_KEYS.longRunningJobsInFlight, nowSeconds(), "job-token"))],
  [/'long_running_jobs' when the only entries are older/, async (r) => void (await r.zadd(REDIS_KEYS.longRunningJobsInFlight, staleScore(6), "dead-job-token"))],
  [
    /'long_running_jobs' when a stale entry sits alongside/,
    async (r) => void (await r.zadd(REDIS_KEYS.longRunningJobsInFlight, staleScore(6), "dead-job-token", nowSeconds(), "live-job-token")),
  ],
  [/'paypal_balance' when PayPal topup is not needed/, async (r) => void (await r.set(REDIS_KEYS.paypalTopupNeeded, "false"))],
  [/'paypal_balance' when PayPal topup is needed/, async (r) => void (await r.set(REDIS_KEYS.paypalTopupNeeded, "true"))],
  [/'stripe_balance' when Stripe topup is not needed/, async (r) => void (await r.set(REDIS_KEYS.stripeBalanceTopupNeeded, "false"))],
  [/'stripe_balance' when Stripe topup is needed/, async (r) => void (await r.set(REDIS_KEYS.stripeBalanceTopupNeeded, "true"))],
  [
    /reports an active registration/,
    async () => stagingBranch(async () => ({ active: true, message: "Apple Pay on my-branch.apps.staging.gumroad.org: active" })),
  ],
  [
    /reports an inactive registration/,
    async () =>
      stagingBranch(async () => ({
        active: false,
        message: "Apple Pay on my-branch.apps.staging.gumroad.org: inactive — Domain verification failed",
      })),
  ],
  [
    /reports Stripe errors/,
    async () =>
      stagingBranch(async () => {
        throw new InvalidRequestError("verification failed", null);
      }),
  ],
  // The spec asserts these never touch Redis, the cache or the database.
  [
    /'index' answers without (reading Redis|checking out)/,
    async () => ({
      redis: () => {
        throw new Error("index read Redis");
      },
      cache: () => {
        throw new Error("index read the cache");
      },
    }),
  ],
];

describe.skipIf(!url || !redisHost)("HealthcheckController parity", () => {
  let client: PrismaClient;
  let sql: SqlExecutor;
  let redis: Redis;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.RAILS_ENV = "test";
    process.env.REDIS_HOST = redisHost;
    process.env.SIDEKIQ_REDIS_HOST = redisHost;
    process.env.SECRET_KEY_BASE ??= "parity-replay-secret-key-base";
    client = new PrismaClient({ datasourceUrl: url });
    sql = prismaExecutor(client);
    setSqlClient(() => client);
    redis = getRedis("main");
  });

  beforeEach(async () => {
    await redis.flushdb();
    resetRailsCacheForTesting();
    setHealthcheckDepsForTesting(null);
  });

  afterAll(async () => {
    setHealthcheckDepsForTesting(null);
    await closeAllRedis();
    await client?.$disconnect();
    process.env = saved;
  });

  const files = readdirSync(FIXTURES).filter((file) => file.endsWith(".json"));

  it("has a fixture for every action but the successful purchases cases", () => {
    const paths = new Set(files.map((file) => loadFixture(path.join(FIXTURES, file)).exchanges[0]!.request.path));
    expect([...paths].sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(files)("%s", async (file) => {
    const fixture = loadFixture(path.join(FIXTURES, file));
    const setup = SETUPS.find(([pattern]) => pattern.test(fixture.example))?.[1];
    const overrides = (await setup?.(redis)) ?? null;
    setHealthcheckDepsForTesting(overrides);

    const route = await ROUTES[fixture.exchanges[0]!.request.path]!();
    // A controller spec bypasses the session middleware, and with it the session cookie and the
    // XSRF-TOKEN cookie committed alongside; the port sends both, as Rails does over HTTP.
    const result = await replayFixture(fixture, { sql, transport: routeHandlers(route), compare: { subset: ["response.cookies"] } });
    assertParity(result);
  });

  it("prunes only the stale payout entry, as the spec checks after the request", async () => {
    await redis.zadd(REDIS_KEYS.payoutBatchInFlight, staleScore(3), "dead-job-token", nowSeconds(), "live-job-token");
    const route = await import("@/app/healthcheck/payouts/route");
    await route.GET(new Request("http://app.test.gumroad.com:31337/healthcheck/payouts"));
    expect(await redis.zscore(REDIS_KEYS.payoutBatchInFlight, "dead-job-token")).toBeNull();
    expect(await redis.zscore(REDIS_KEYS.payoutBatchInFlight, "live-job-token")).not.toBeNull();
  });

  it("reads Sidekiq's queue lengths and retry set the way Sidekiq::Queue#size and RetrySet#size do", async () => {
    const sidekiq = getRedis("sidekiq");
    await sidekiq.lpush("queue:default", "a", "b", "c");
    await sidekiq.zadd("retry", 1, "x", 2, "y");
    expect(await defaultHealthcheckDeps.sidekiqQueueSize("default")).toBe(3);
    expect(await defaultHealthcheckDeps.sidekiqQueueSize("critical")).toBe(0);
    expect(await defaultHealthcheckDeps.sidekiqRetrySetSize()).toBe(2);
  });

  it("prunes a lone stale long-running job entry", async () => {
    await redis.zadd(REDIS_KEYS.longRunningJobsInFlight, staleScore(6), "dead-job-token");
    const route = await import("@/app/healthcheck/long_running_jobs/route");
    const response = await route.GET(new Request("http://app.test.gumroad.com:31337/healthcheck/long_running_jobs"));
    expect(response.status).toBe(200);
    expect(await redis.zcard(REDIS_KEYS.longRunningJobsInFlight)).toBe(0);
  });
});
