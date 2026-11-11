import { readFileSync } from "node:fs";

import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { countThrottles, normalizePath, RULES, type ThrottleRequest, throttledResponse } from "./rack-attack.ts";

// rack-attack-throttles.golden.json comes from rack_attack.rb itself (__fixtures__/generators/rack_attack_throttles.rb): every throttle in
// definition order, and the Redis keys and TTLs Rack::Attack writes for one request with the clock frozen.
type Golden = {
  throttles: { name: string; limit: number; period: number }[];
  normalized_paths: Record<string, string>;
  counts: {
    name: string;
    method: string;
    path: string;
    authorization?: string | null;
    at: number;
    ip: string;
    keys: Record<string, { value: number; ttl: number }>;
  }[];
};
const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/rack-attack-throttles.golden.json", import.meta.url), "utf8"),
) as Golden;

class FakeRedis {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  pipeline() {
    const queue: (() => number)[] = [];
    const chain = {
      incrby: (key: string, by: number) => {
        queue.push(() => {
          this.values.set(key, (this.values.get(key) ?? 0) + by);
          return this.values.get(key)!;
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        queue.push(() => {
          this.ttls.set(key, seconds);
          return 1;
        });
        return chain;
      },
      decr: (key: string) => {
        queue.push(() => {
          this.values.set(key, (this.values.get(key) ?? 0) - 1);
          return this.values.get(key)!;
        });
        return chain;
      },
      exec: async () => queue.map((run) => [null, run()] as const),
    };
    return chain;
  }
}

function requestFor(
  method: string,
  target: string,
  authorization?: string | null,
  ip = "203.0.113.9",
): ThrottleRequest {
  const url = new URL(target, "http://app.test.gumroad.com");
  const headers = new Headers({ "cf-connecting-ip": ip });
  if (authorization) headers.set("authorization", authorization);
  return {
    method,
    path: url.pathname,
    headers,
    params: async () => Object.fromEntries(url.searchParams),
  };
}

const count = (fake: FakeRedis, request: ThrottleRequest, at: number) =>
  countThrottles(request, { redis: fake as unknown as Redis, now: () => at * 1000 });

describe("Rack::Attack throttles", () => {
  it("defines each throttle with the name, limit and period of rack_attack.rb, in its order", () => {
    const modelled = RULES.flatMap((rule) => rule.throttles);
    const indexes = modelled.map((throttle) => golden.throttles.findIndex((entry) => entry.name === throttle.name));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(modelled.map(({ name, limit, period }) => ({ name, limit, period }))).toEqual(
      indexes.map((index) => golden.throttles[index]),
    );
  });

  for (const entry of golden.counts) {
    it(`writes the keys and expiries Rack::Attack writes for ${entry.name}`, async () => {
      const fake = new FakeRedis();
      const outcome = await count(fake, requestFor(entry.method, entry.path, entry.authorization, entry.ip), entry.at);
      expect(outcome.throttled).toBeNull();
      expect(Object.fromEntries(fake.values)).toEqual(
        Object.fromEntries(Object.entries(entry.keys).map(([key, { value }]) => [key, value])),
      );
      // Redis reports the TTL a moment after Rails set it.
      for (const [key, { ttl }] of Object.entries(entry.keys)) expect(fake.ttls.get(key)! - ttl).toBeLessThanOrEqual(1);
    });
  }

  it("normalizes a path as Rack::Attack does before matching it", () => {
    for (const [path, normalized] of Object.entries(golden.normalized_paths))
      expect(normalizePath(path), path).toBe(normalized);
  });

  it("trips at the request past the limit and reports the time left in the window", async () => {
    const fake = new FakeRedis();
    const request = requestFor("GET", "/discover");
    const at = 1_700_000_000;
    for (let index = 0; index < 60; index++) expect((await count(fake, request, at)).throttled).toBeNull();
    const outcome = await count(fake, request, at);
    expect(outcome.throttled).toEqual({ name: "/ip:/discover", retryAfter: 10 });
    expect(Array.from(fake.values.values()).every((value) => value >= 1)).toBe(true);
  });

  it("takes back what it counted so a request handed to Rails is counted once", async () => {
    const fake = new FakeRedis();
    const outcome = await count(fake, requestFor("POST", "/claude/v1/oauth2/register"), 1_700_000_000);
    await outcome.undo();
    expect(Array.from(fake.values.values())).toEqual([0, 0, 0, 0, 0]);
  });

  it("does not count localhost, other methods or paths outside the rules", async () => {
    const fake = new FakeRedis();
    await count(fake, requestFor("GET", "/discover", null, "127.0.0.1"), 1_700_000_000);
    await count(fake, requestFor("GET", "/muse/v1/oauth2/register"), 1_700_000_000);
    await count(fake, requestFor("GET", "/v2/sales?page=10"), 1_700_000_000);
    await count(fake, requestFor("GET", "/v2/sales?page=abc"), 1_700_000_000);
    expect(fake.values.size).toBe(0);
  });

  it("answers Rack::Attack's default 429", async () => {
    const response = throttledResponse(7);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toBe("Retry later\n");
  });
});
