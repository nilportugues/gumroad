import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { leaseRedisDatabase, REDIS_LEASE_KEY } from "../src/session";

const host = process.env.PARITY_REDIS_HOST;
const DEAD_PID = 2 ** 22 + 1;

describe.skipIf(!host)("Redis database lease", () => {
  let redis: Redis;

  beforeAll(() => {
    const [hostAndPort = "", db = "0"] = host!.split("/");
    const [name = "127.0.0.1", port = "6379"] = hostAndPort.split(":");
    redis = new Redis({ host: name, port: Number(port), db: Number(db) });
  });

  afterAll(async () => {
    await redis.del(REDIS_LEASE_KEY);
    await redis.quit();
  });

  it("refuses a second run while the first run's process is alive", async () => {
    await redis.del(REDIS_LEASE_KEY);
    await leaseRedisDatabase(redis, process.pid);
    await expect(leaseRedisDatabase(redis, DEAD_PID)).rejects.toThrow(/is leased by process/u);
  });

  it("lets the same run lease again", async () => {
    await redis.del(REDIS_LEASE_KEY);
    await leaseRedisDatabase(redis, process.pid);
    await expect(leaseRedisDatabase(redis, process.pid)).resolves.toBeUndefined();
  });

  it("takes over the lease of a run that is gone", async () => {
    await redis.set(REDIS_LEASE_KEY, String(DEAD_PID));
    await leaseRedisDatabase(redis, process.pid);
    expect(await redis.get(REDIS_LEASE_KEY)).toBe(String(process.pid));
  });
});
