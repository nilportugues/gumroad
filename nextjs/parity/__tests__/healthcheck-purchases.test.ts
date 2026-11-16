import { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { railsCache, resetRailsCacheForTesting } from "@/server/cache/rails-cache";
import { REDIS_KEYS, setHealthcheckDepsForTesting } from "@/server/controllers/healthcheck";
import { closeAllRedis, getRedis } from "@/server/infra/redis";
import { setSqlClient } from "@/server/models/sql";
import { setSubdomainRedirectorDepsForTesting } from "@/server/services/subdomain-redirector";

// GET /healthcheck/purchases, from the "GET 'purchases'" group of healthcheck_controller_spec.rb.
// Only the threshold-not-set example was recorded (the purchase factory needs a Stripe charge),
// so the others are ported here against the same table.
const url = process.env.PARITY_DATABASE_URL;
const redisHost = process.env.PARITY_REDIS_HOST;
const MINUTE_MS = 60_000;

describe.skipIf(!url || !redisHost)("GET /healthcheck/purchases", () => {
  let client: PrismaClient;
  let redis: Redis;
  const saved = { ...process.env };

  async function purchase(state: string, minutesAgo: number) {
    const createdAt = new Date(Date.now() - minutesAgo * MINUTE_MS);
    await client.$executeRaw`INSERT INTO purchases (purchase_state, created_at, updated_at) VALUES (${state}, ${createdAt}, ${createdAt})`;
  }

  async function get() {
    const { GET } = await import("@/app/healthcheck/purchases/route");
    const response = await GET(new Request("http://app.test.gumroad.com:31337/healthcheck/purchases"));
    return { status: response.status, body: await response.text() };
  }

  beforeAll(() => {
    process.env.RAILS_ENV = "test";
    process.env.REDIS_HOST = redisHost;
    process.env.SECRET_KEY_BASE ??= "parity-replay-secret-key-base";
    client = new PrismaClient({ datasourceUrl: url });
    setSqlClient(() => client);
    redis = getRedis("main");
    setSubdomainRedirectorDepsForTesting({ readConfig: async () => null });
  });

  beforeEach(async () => {
    await client.$executeRawUnsafe("DELETE FROM purchases");
    await redis.flushdb();
    resetRailsCacheForTesting();
    setHealthcheckDepsForTesting(null);
  });

  afterAll(async () => {
    await client?.$executeRawUnsafe("DELETE FROM purchases");
    setSubdomainRedirectorDepsForTesting(null);
    await closeAllRedis();
    await client?.$disconnect();
    process.env = saved;
  });

  it("returns HTTP success when the successful purchases count meets the threshold", async () => {
    await purchase("successful", 5);
    await purchase("successful", 5);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "2");

    expect(await get()).toEqual({ status: 200, body: "Purchases: ok" });
  });

  it("returns HTTP service_unavailable when the count is below the threshold", async () => {
    await purchase("successful", 5);
    await purchase("successful", 5);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "3");

    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
  });

  it("ignores successful purchases older than 10 minutes", async () => {
    await purchase("successful", 15);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "1");

    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
  });

  it("counts only successful purchases", async () => {
    await purchase("failed", 1);
    await purchase("in_progress", 1);
    await purchase("successful", 1);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "2");

    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
  });

  it("returns HTTP service_unavailable when the Redis threshold is not set or blank", async () => {
    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "  ");
    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
  });

  it("reads the threshold with String#to_i", async () => {
    await purchase("successful", 1);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, " 1 purchase");
    expect(await get()).toEqual({ status: 200, body: "Purchases: ok" });
    // "abc".to_i is 0, which any count meets.
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "abc");
    expect(await get()).toEqual({ status: 200, body: "Purchases: ok" });
  });

  it("caches the count for 30 seconds under Rails' key", async () => {
    await purchase("successful", 1);
    await redis.set(REDIS_KEYS.minSuccessfulPurchasesInLast10Minutes, "2");
    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });

    await purchase("successful", 1);
    expect(await get()).toEqual({ status: 503, body: "Purchases: service_unavailable" });
    expect(await railsCache().read("healthcheck:purchases:successful_last_10_minutes")).toBe(1);
  });
});
