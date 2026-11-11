import { describe, expect, it } from "vitest";

import { evaluate, rackRequest, type RackStore, type Throttle } from "./rack-attack.ts";

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

describe("evaluate", () => {
  it("counts on the key Rack::Attack uses: prefix, window number, rule name and discriminator", async () => {
    const store = memoryStore();
    const rule: Throttle = { name: "demo", limit: 3, period: 20, discriminator: () => "who" };
    await evaluate(request("/"), store, [rule], () => NOW);
    expect([...store.counts.keys()]).toEqual([`rack::attack:${Math.floor(NOW / 20)}:demo:who`]);
  });

  it("expires the key one second after the window ends", async () => {
    const store = memoryStore();
    await evaluate(
      request("/"),
      store,
      [{ name: "demo", limit: 3, period: 20, discriminator: () => "who" }],
      () => NOW,
    );
    expect([...store.expiries.values()]).toEqual([20 - (NOW % 20) + 1]);
  });

  it("answers the rule over its limit with the period and the epoch time of the count", async () => {
    const store = memoryStore();
    const rule: Throttle = { name: "demo", limit: 2, period: 60, discriminator: () => "who" };
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push(await evaluate(request("/"), store, [rule], () => NOW));
    expect(outcomes).toEqual([null, null, { name: "demo", period: 60, epochTime: NOW }]);
  });

  it("stops at the first rule over its limit, leaving later rules uncounted", async () => {
    const store = memoryStore();
    const rules: Throttle[] = [
      { name: "first", limit: 0, period: 60, discriminator: () => "a" },
      { name: "second", limit: 5, period: 60, discriminator: () => "a" },
    ];
    await evaluate(request("/"), store, rules, () => NOW);
    expect([...store.counts.keys()].map((key) => key.split(":").slice(-2)[0])).toEqual(["first"]);
  });

  it("skips a rule whose discriminator is null and counts an empty one", async () => {
    const store = memoryStore();
    const rules: Throttle[] = [
      { name: "none", limit: 1, period: 60, discriminator: () => null },
      { name: "empty", limit: 1, period: 60, discriminator: () => "" },
    ];
    await evaluate(request("/"), store, rules, () => NOW);
    expect([...store.counts.keys()]).toEqual([`rack::attack:${Math.floor(NOW / 60)}:empty:`]);
  });

  it("does not count a request from localhost", async () => {
    const store = memoryStore();
    const rule: Throttle = { name: "demo", limit: 0, period: 60, discriminator: () => "who" };
    expect(await evaluate(request("/", { ip: "127.0.0.1" }), store, [rule], () => NOW)).toBeNull();
    expect(await evaluate(request("/", { ip: "::1" }), store, [rule], () => NOW)).toBeNull();
    expect(store.counts.size).toBe(0);
  });

  it("keeps the keys it counted so they can be taken back", async () => {
    const store = memoryStore();
    const keys: string[] = [];
    const rule: Throttle = { name: "demo", limit: 3, period: 60, discriminator: () => "who" };
    await evaluate(request("/"), store, [rule], () => NOW, keys);
    expect(keys).toEqual([`rack::attack:${Math.floor(NOW / 60)}:demo:who`]);
  });
});

describe("rackRequest", () => {
  it("prefers Cloudflare's address over the forwarded chain", () => {
    expect(request("/", { headers: { "x-forwarded-for": "198.51.100.4" } }).remoteIp).toBe("203.0.113.9");
  });

  it("reads the form body only from a form content type, as Rack's POST does", () => {
    const body = new TextEncoder().encode("user_id=abc");
    const form = rackRequest(
      new Request("http://app.test.gumroad.com/two-factor", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" },
        body,
      }),
      body,
    );
    const json = rackRequest(
      new Request("http://app.test.gumroad.com/two-factor", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body,
      }),
      new TextEncoder().encode('{"user_id":"abc"}'),
    );
    expect(form.form).toEqual({ user_id: "abc" });
    expect(json.form).toEqual({});
    expect(json.json).toEqual({ user_id: "abc" });
  });
});
