import { afterEach, describe, expect, it } from "vitest";

import { closeAllRedis, getNamespacedRedis, getRedis, namespacedKey, redisUrl } from "./redis";

describe("Redis URLs match the Rails initializers", () => {
  const savedEnv = { ...process.env };
  afterEach(async () => {
    process.env = { ...savedEnv };
    await closeAllRedis();
  });

  it("builds each URL from the same ENV var Rails reads", () => {
    Object.assign(process.env, {
      REDIS_HOST: "localhost:6379/0",
      SIDEKIQ_REDIS_HOST: "localhost:6379/1",
      RPUSH_REDIS_HOST: "localhost:6379/2",
      RACK_ATTACK_REDIS_HOST: "localhost:6379/3",
    });
    delete process.env.ANYCABLE_REDIS_URL;

    expect(redisUrl("main")).toBe("redis://localhost:6379/0");
    expect(redisUrl("sidekiq")).toBe("redis://localhost:6379/1");
    expect(redisUrl("rpush")).toBe("redis://localhost:6379/2");
    expect(redisUrl("rackAttack")).toBe("redis://localhost:6379/3");
    expect(redisUrl("anycable")).toBe("redis://localhost:6379/0/5");
  });

  it("prefers ANYCABLE_REDIS_URL, as config/cable.yml does", () => {
    process.env.ANYCABLE_REDIS_URL = "redis://cable:6379/7";
    expect(redisUrl("anycable")).toBe("redis://cable:6379/7");
  });

  it("requires RACK_ATTACK_REDIS_HOST like ENV.fetch", () => {
    delete process.env.RACK_ATTACK_REDIS_HOST;
    expect(() => redisUrl("rackAttack")).toThrow(/RACK_ATTACK_REDIS_HOST/);
  });

  it("selects the database from the host string and connects lazily", () => {
    process.env.REDIS_HOST = "localhost:6379/4";
    const client = getRedis("main");
    expect(client.options.db).toBe(4);
    expect(client.status).toBe("wait");
    expect(getRedis("main")).toBe(client);
  });

  it("prefixes keys the way Redis::Namespace does", () => {
    process.env.REDIS_HOST = "localhost:6379/0";
    expect(namespacedKey("ppp", "US")).toBe("ppp:US");
    expect(getNamespacedRedis("ppp").options.keyPrefix).toBe("ppp:");
  });
});
