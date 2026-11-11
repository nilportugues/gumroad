import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

// The golden cases are signed out and hold no OAuth token; the examples below set both.
const stubs = vi.hoisted(() => ({
  wardenUser: null as { id: bigint } | null,
  token: null as {
    resource_owner_id: number;
    expires_in: number | null;
    created_at: Date;
    revoked_at: Date | null;
  } | null,
  paidCents: 0,
}));
vi.mock("./signed-in-filters.ts", () => ({
  resolveRequestAuth: () =>
    Promise.resolve({
      context: { loggedInUser: stubs.wardenUser },
      effects: { signedOut: null },
      authenticatedVia: stubs.wardenUser === null ? null : "session",
    }),
}));
vi.mock("../../lib/db.ts", () => ({
  db: {
    oauthAccessToken: { findFirst: () => Promise.resolve(stubs.token) },
    user: { findUnique: () => Promise.resolve({ id: 7n }) },
    payment: { aggregate: () => Promise.resolve({ _sum: { amount_cents: BigInt(stubs.paidCents) } }) },
  },
}));

import { HandBackToRails } from "./application-controller.ts";
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
    query?: string;
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
    // The golden is dumped with the production block loaded last, so those rules are checked by name and value but not by position.
    const inOrder = RACK_ATTACK_RULES.filter((rule) => rule.productionOnly !== true);
    const indexes = inOrder.map((rule) => golden.throttles.findIndex((entry) => entry.name === rule.name));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(inOrder.map(({ name, limit, period }) => ({ name, limit, period }))).toEqual(
      indexes.map((index) => golden.throttles[index]),
    );
  });

  // Rack parses a key or value that is not valid UTF-8 without raising and counts nothing; Node's parser does not read it, so it hands the request back.
  const HANDED_BACK = new Set(["invalid utf-8"]);
  for (const entry of golden.counts.filter(({ name }) => HANDED_BACK.has(name))) {
    it(`hands ${entry.name} back to Rails, which counts nothing for it`, () => {
      expect(Object.keys(entry.keys)).toEqual([]);
      expect(() => request(`${entry.path}?${entry.query}`)).toThrow(HandBackToRails);
    });
  }

  for (const entry of golden.counts.filter(({ name }) => !HANDED_BACK.has(name))) {
    it(`writes the keys and expiries Rack::Attack writes for ${entry.name}`, async () => {
      const store = memoryStore();
      const headers: Record<string, string> = {};
      if (entry.authorization) headers.authorization = entry.authorization;
      const rack = request(entry.query === undefined ? entry.path : `${entry.path}?${entry.query}`, {
        method: entry.method,
        headers,
        ip: entry.ip,
      });
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

describe("rules that read the signed-in user, a token or the params", () => {
  const writer = (headers: Record<string, string> = { authorization: "Bearer tok" }) =>
    request("/v2/products/p", { method: "PUT", headers });
  const names = (store: ReturnType<typeof memoryStore>) =>
    [...store.counts.keys()].map((key) => key.replace(/^rack::attack:\d+:/u, ""));

  it("counts a product write of a non-VIP token in the ip and token buckets", async () => {
    stubs.token = { resource_owner_id: 7, expires_in: null, created_at: new Date(), revoked_at: null };
    stubs.paidCents = 500_000;
    const store = memoryStore();
    await run(store, writer());
    expect(names(store).filter((name) => name.startsWith("/ip:") || name.startsWith("/params:"))).toHaveLength(11);
    expect(names(store).some((name) => name.startsWith("/vip/"))).toBe(false);
  });

  it("counts a product write of a creator past the payout threshold in the VIP buckets only", async () => {
    stubs.token = { resource_owner_id: 7, expires_in: null, created_at: new Date(), revoked_at: null };
    stubs.paidCents = 500_001;
    const store = memoryStore();
    await run(store, writer());
    expect(names(store)).toHaveLength(11);
    expect(names(store).every((name) => name.startsWith("/vip/"))).toBe(true);
  });

  it("treats a revoked token, an unknown token and a missing token as non-VIP", async () => {
    stubs.paidCents = 600_000;
    stubs.token = { resource_owner_id: 7, expires_in: null, created_at: new Date(), revoked_at: new Date(0) };
    const revoked = memoryStore();
    await run(revoked, writer());
    stubs.token = null;
    const unknown = memoryStore();
    await run(unknown, writer());
    const missing = memoryStore();
    await run(missing, writer({}));
    for (const store of [revoked, unknown, missing])
      expect(names(store).some((name) => name.startsWith("/vip/"))).toBe(false);
  });

  it("keys the totp rule on the Warden user, and on nothing when signed out for a passkey rule", async () => {
    stubs.wardenUser = { id: 42n };
    const signedIn = memoryStore();
    await run(signedIn, request("/settings/totp/confirm", { method: "POST" }));
    await run(signedIn, request("/settings/passkeys", { method: "POST" }));
    expect(names(signedIn).filter((name) => name.includes(":42"))).toHaveLength(12);
    stubs.wardenUser = null;
    const signedOut = memoryStore();
    await run(signedOut, request("/settings/passkeys", { method: "POST" }));
    await run(signedOut, request("/products/p/marketing_actions/m/execute.json", { method: "POST" }));
    expect(names(signedOut)).toEqual([]);
  });

  it("counts an unparseable request in invalid_params and skips the rules that read params", async () => {
    const store = memoryStore();
    await run(store, request(`/follow?seller_id=%zz`, { method: "POST" }));
    expect(names(store).filter((name) => name.startsWith("invalid_params"))).toHaveLength(7);
    expect(names(store).some((name) => name.includes("/follow"))).toBe(true);
    expect(names(store).some((name) => name.startsWith("/ip/params:/follow"))).toBe(false);
  });

  it("trips invalid_params at the sixth request of a minute", async () => {
    const store = memoryStore();
    let tripped = null;
    for (let index = 0; index < 6; index += 1)
      tripped = await run(store, request("/anything?a=%", { ip: "203.0.113.5" }));
    expect(tripped).toEqual({ name: "invalid_params", period: 60, epochTime: NOW });
  });
});
