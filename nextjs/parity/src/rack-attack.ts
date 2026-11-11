import type { Redis } from "ioredis";
import { expect } from "vitest";

import type { RedisSeeder } from "./replay";

// A Rack::Attack throttle is counted per client and window, so a recorded 429 depends on the requests that came before it. The Rails example adds
// them to the counter directly (`Rack::Attack.cache.count`), and the replay adds the same count to Node's Redis after the seeder's reset.
export type Preload = { tier: string; period: number; discriminator: string; count: number };

// A replay's `redis` option that seeds as usual and then sets the counter of the window the request will land in.
export function withPreload(redis: Redis, seeder: RedisSeeder, preload: Preload | undefined): RedisSeeder {
  return {
    async reset(entries) {
      await seeder.reset(entries);
      if (preload === undefined) return;
      const bucket = Math.trunc(Date.now() / 1000 / preload.period);
      await redis.set(
        `rack::attack:${bucket}:${preload.tier}:${preload.discriminator}`,
        preload.count,
        "EX",
        preload.period * 2,
      );
    },
  };
}

// The window ends at another instant than in the recording, so Retry-After is checked against the clock instead of the fixture.
export function expectRetryAfter(response: { status: number; headers: Record<string, unknown> }, periods: number[]) {
  if (response.status !== 429) return;
  const retryAfter = Number(response.headers["retry-after"]);
  expect(retryAfter).toBeGreaterThan(0);
  expect(periods.some((period) => retryAfter <= period)).toBe(true);
}
