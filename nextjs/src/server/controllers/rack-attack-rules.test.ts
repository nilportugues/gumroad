import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evaluate, normalizePath, RACK_ATTACK_RULES, rackRequest, type RackStore } from "./rack-attack.ts";

// parity/golden/rack-attack-throttles.json comes from rack_attack.rb itself (scripts/golden/rack-attack-throttles.rb): every throttle in
// definition order, the Redis keys and TTLs Rack::Attack writes for one request with the clock frozen, and the paths it normalizes.
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
  readFileSync(new URL("../../../parity/golden/rack-attack-throttles.json", import.meta.url), "utf8"),
) as Golden;

function memoryStore(): RackStore & { counts: Map<string, number>; expiries: Map<string, number> } {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  return {
    counts,
    expiries,
    increment(key, expiresIn) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      expiries.set(key, expiresIn);
      return Promise.resolve(counts.get(key)!);
    },
    decrement(key) {
      counts.set(key, (counts.get(key) ?? 0) - 1);
      return Promise.resolve();
    },
  };
}

const NOW = 1_700_000_015;
const request = (path: string, init: RequestInit & { ip?: string } = {}) => {
  const { ip = "203.0.113.9", ...rest } = init;
  return rackRequest(
    new Request(`http://app.test.gumroad.com${path}`, {
      method: "GET",
      ...rest,
      headers: { "cf-connecting-ip": ip, ...(rest.headers as Record<string, string> | undefined) },
    }),
    new Uint8Array(),
  );
};
const run = (store: RackStore, rack: ReturnType<typeof request>, at = NOW, keys: string[] = []) =>
  evaluate(rack, store, RACK_ATTACK_RULES, () => at, keys);

describe("golden of rack_attack.rb", () => {
  it("defines each modelled throttle with the name, limit and period of rack_attack.rb, in its order", () => {
    const indexes = RACK_ATTACK_RULES.map((rule) => golden.throttles.findIndex((entry) => entry.name === rule.name));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(RACK_ATTACK_RULES.map(({ name, limit, period }) => ({ name, limit, period }))).toEqual(
      indexes.map((index) => golden.throttles[index]),
    );
  });

  for (const entry of golden.counts) {
    it(`writes the keys and expiries Rack::Attack writes for ${entry.name}`, async () => {
      const store = memoryStore();
      const headers: Record<string, string> = {};
      if (entry.authorization) headers.authorization = entry.authorization;
      const rack = request(entry.path, { method: entry.method, headers, ip: entry.ip });
      expect(await run(store, rack, entry.at)).toBeNull();
      expect(Object.fromEntries(store.counts)).toEqual(
        Object.fromEntries(Object.entries(entry.keys).map(([key, { value }]) => [key, value])),
      );
      // Redis reports the TTL a moment after Rails set it.
      for (const [key, { ttl }] of Object.entries(entry.keys))
        expect(store.expiries.get(key)! - ttl).toBeLessThanOrEqual(1);
    });
  }

  it("normalizes a path as Rack::Attack does before matching it", () => {
    for (const [path, normalized] of Object.entries(golden.normalized_paths))
      expect(normalizePath(path), path).toBe(normalized);
  });
});

describe("rules of the API v2 and mobile routes", () => {
  it("trips at the request past the limit and reports the time left in the window", async () => {
    const store = memoryStore();
    const at = 1_700_000_000;
    for (let index = 0; index < 60; index += 1) expect(await run(store, request("/discover"), at)).toBeNull();
    expect(await run(store, request("/discover"), at)).toEqual({ name: "/ip:/discover", period: 30, epochTime: at });
  });

  it("counts the sales index only past page ten", async () => {
    const store = memoryStore();
    await run(store, request("/v2/sales?page=10"));
    await run(store, request("/v2/sales?page=abc"));
    expect(store.counts.size).toBe(0);
    await run(store, request("/api/v2/sales?page=11"));
    expect([...store.counts.keys()]).toEqual([`rack::attack:${NOW}:/api/v2/sales:203.0.113.9`]);
  });

  it("downcases the discriminator and reads a bearer token the way v2_product_token does", async () => {
    const store = memoryStore();
    await run(
      store,
      request("/v2/user/preview_custom_html", { method: "POST", headers: { authorization: "Bearer TokenABC" } }),
    );
    expect([...store.counts.keys()].some((key) => key.endsWith(":/v2/user/preview_custom_html:tokenabc"))).toBe(true);
  });

  it("does not count localhost or a path outside the rules", async () => {
    const store = memoryStore();
    await run(store, request("/discover", { ip: "127.0.0.1" }));
    await run(store, request("/muse/v1/oauth2/register"));
    expect(store.counts.size).toBe(0);
  });

  it("returns the keys it counted so a request handed to Rails can be counted once", async () => {
    const store = memoryStore();
    const keys: string[] = [];
    await run(store, request("/claude/v1/oauth2/register", { method: "POST" }), NOW, keys);
    expect(keys).toHaveLength(5);
    for (const key of keys) await store.decrement(key);
    expect([...store.counts.values()]).toEqual([0, 0, 0, 0, 0]);
  });
});
