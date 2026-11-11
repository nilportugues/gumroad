import type { Redis } from "ioredis";

import { evaluate, RACK_ATTACK_RULES, rackRequest } from "@/server/controllers/rack-attack";

import type { FixtureRequest } from "./fixture";

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
