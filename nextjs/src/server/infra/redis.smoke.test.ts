import { afterAll, describe, expect, it } from "vitest";

import { isFeatureEnabled } from "./flipper";
import { closeAllRedis, getNamespacedRedis, getRedis } from "./redis";

// Runs only against a live Redis: SMOKE_REDIS_HOST=localhost:6379/9 npx vitest run redis.smoke.
// Expects Rails (or flipper-redis) to have run, on that database:
//   Flipper.enable(:smoke_bool); Flipper.enable_actor(:smoke_actor, Flipper::Actor.new("User;42"))
//   Flipper.enable_percentage_of_actors(:smoke_pct, 30)
// and SMOKE_FLIPPER_PCT_ACTORS to list the ids Ruby reported as enabled for smoke_pct among User;1..50.
const host = process.env.SMOKE_REDIS_HOST;

describe.skipIf(!host)("Redis and Flipper against a live Redis", () => {
  process.env.REDIS_HOST = host;
  afterAll(() => closeAllRedis());

  it("round-trips a namespaced key where Redis::Namespace would put it", async () => {
    await getNamespacedRedis("ppp").set("smoke", "1", "EX", 60);
    expect(await getRedis("main").get("ppp:smoke")).toBe("1");
  });

  it("reads the flags Ruby's Flipper wrote", async () => {
    expect(await isFeatureEnabled("smoke_bool")).toBe(true);
    expect(await isFeatureEnabled("smoke_actor", "User;42")).toBe(true);
    expect(await isFeatureEnabled("smoke_actor", "User;43")).toBe(false);
    const ids = Array.from({ length: 50 }, (_, i) => `User;${i + 1}`);
    const enabled = [];
    for (const id of ids) if (await isFeatureEnabled("smoke_pct", id)) enabled.push(id);
    expect(enabled.join(",")).toBe(process.env.SMOKE_FLIPPER_PCT_ACTORS);
  });
});
