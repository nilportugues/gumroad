import type { Redis } from "ioredis";

import { matchingThrottles, throttleKey, type ThrottleRequest } from "@/server/infra/rack-attack";

import type { FixtureRequest } from "./fixture";

// A fixture request as the throttle sees it: the headers the recording sent and the query string as `params`.
export function throttleRequestOf(request: FixtureRequest): ThrottleRequest {
  const headers = new Headers(request.headers);
  const params = Object.fromEntries(new URLSearchParams(request.query ?? ""));
  return { method: request.method, path: request.path, headers, params: async () => params };
}

// Puts the first throttle of the request on the brink of its limit, so the replayed request is the one that trips it. Rack::Attack counted
// to the same value in the recording; the replay cannot re-run that loop against Rails.
export async function fillFirstThrottle(redis: Redis, request: FixtureRequest): Promise<{ name: string; limit: number }> {
  const [first] = await matchingThrottles(throttleRequestOf(request));
  if (!first) throw new Error(`no Rack::Attack throttle covers ${request.method} ${request.path}`);
  const key = throttleKey(first.throttle, first.discriminator, Math.floor(Date.now() / 1000));
  await redis.set(key, first.throttle.limit, "EX", first.throttle.period + 1);
  return { name: first.throttle.name, limit: first.throttle.limit };
}

// Every `rack::attack:` counter and its value.
export async function rackAttackCounters(redis: Redis): Promise<Record<string, number>> {
  const keys = (await redis.keys("rack::attack:*")).sort();
  const values = await Promise.all(keys.map((key) => redis.get(key)));
  return Object.fromEntries(keys.map((key, index) => [key, Number(values[index])]));
}
