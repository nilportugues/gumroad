import type { Redis } from "ioredis";
import { expect } from "vitest";

import { evaluate, RACK_ATTACK_RULES, rackRequest } from "@/server/controllers/rack-attack";

import type { FixtureRequest } from "./fixture";
import type { RedisSeeder } from "./replay";

// A fixture request as the counter sees it: the headers the recording sent and the query string in the URL.
function rackRequestOf(request: FixtureRequest) {
  const url = `http://app.test.gumroad.com${request.path}${request.query ? `?${request.query}` : ""}`;
  return rackRequest(new Request(url, { method: request.method, headers: request.headers }), new Uint8Array());
}

// Puts the first throttle of the request on the brink of its limit, so the replayed request is the one that trips it. Rack::Attack counted
// to the same value in the recording; the replay cannot re-run that loop against Rails.
export async function fillFirstThrottle(
  redis: Redis,
  request: FixtureRequest,
): Promise<{ name: string; limit: number }> {
  const rack = rackRequestOf(request);
  for (const rule of RACK_ATTACK_RULES) {
    const keys: string[] = [];
    // A store that counts nothing, to learn which key the rule would write.
    const probe = { increment: async () => 0, decrement: async () => undefined };
    await evaluate(rack, probe, [rule], undefined, keys);
    if (keys[0] === undefined) continue;
    await redis.set(keys[0], rule.limit, "EX", rule.period + 1);
    return { name: rule.name, limit: rule.limit };
  }
  throw new Error(`no Rack::Attack throttle covers ${request.method} ${request.path}`);
}

// Every `rack::attack:` counter and its value.
export async function rackAttackCounters(redis: Redis): Promise<Record<string, number>> {
  const keys = (await redis.keys("rack::attack:*")).sort();
  const values = await Promise.all(keys.map((key) => redis.get(key)));
  return Object.fromEntries(keys.map((key, index) => [key, Number(values[index])]));
}

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
