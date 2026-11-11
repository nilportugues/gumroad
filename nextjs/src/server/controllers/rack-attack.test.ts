import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, number>();
const expiries = new Map<string, number>();
const redis = {
  pipeline(commands?: string[][]) {
    const queued: (() => [null, number])[] = (commands ?? []).map(([, key]) => () => {
      store.set(key!, (store.get(key!) ?? 0) - 1);
      return [null, store.get(key!)!];
    });
    const chain = {
      incrby(key: string, by: number) {
        queued.push(() => {
          store.set(key, (store.get(key) ?? 0) + by);
          return [null, store.get(key)!];
        });
        return chain;
      },
      expire(key: string, seconds: number) {
        queued.push(() => {
          expiries.set(key, seconds);
          return [null, 1];
        });
        return chain;
      },
      exec: () => Promise.resolve(queued.map((run) => run())),
    };
    return chain;
  },
};
vi.mock("../infra/redis.ts", () => ({ getRedis: () => redis }));

const { clientIp, countThrottles, exponentialBackoff, throttleByIp, throttled } = await import("./rack-attack.ts");
const { forwardToRails } = await import("./application-controller.ts");

const AT = 1_800_000_001_000;
const headers = (ip: string) => new Headers({ "cf-connecting-ip": ip });
const req = (ip: string, path = "/p") => new Request(`http://example.com${path}`, { headers: headers(ip) });

beforeEach(() => {
  store.clear();
  expiries.clear();
  vi.useFakeTimers({ now: AT, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("exponentialBackoff", () => {
  it("derives the tiers of throttle_with_exponential_backoff", () => {
    expect(exponentialBackoff("n", 60, 30, 5)).toEqual([
      { name: "n", limit: 60, period: 30 },
      { name: "n/2", limit: 240, period: 64 },
      { name: "n/3", limit: 360, period: 512 },
      { name: "n/4", limit: 480, period: 4096 },
      { name: "n/5", limit: 600, period: 32_768 },
    ]);
  });

  it("names a throttle_by_ip rule after its path", () => {
    expect(throttleByIp("/offer_codes/compute_discount", 60, 30)[0]).toEqual({
      name: "/ip:/offer_codes/compute_discount",
      limit: 60,
      period: 30,
    });
  });
});

describe("clientIp", () => {
  it("prefers CF-Connecting-IP, then the last public X-Forwarded-For entry, then loopback", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers())).toBe("127.0.0.1");
  });
});

describe("countThrottles", () => {
  const tiers = throttleByIp("/p", 2, 30, 2);

  it("increments Rack::Attack's key of the window with the window's remaining time plus one as expiry", async () => {
    await countThrottles(req("203.0.113.7"), tiers);

    const key = `rack::attack:${Math.trunc(1_800_000_001 / 30)}:/ip:/p:203.0.113.7`;
    expect(store.get(key)).toBe(1);
    expect(expiries.get(key)).toBe(30 - (1_800_000_001 % 30) + 1);
  });

  it("answers 429 with the remaining window once the limit is passed and leaves the later tiers uncounted", async () => {
    await countThrottles(req("203.0.113.7"), tiers);
    await countThrottles(req("203.0.113.7"), tiers);
    const third = await countThrottles(req("203.0.113.7"), tiers);

    expect(third.response?.status).toBe(429);
    expect(third.response?.headers.get("retry-after")).toBe(String(30 - (1_800_000_001 % 30)));
    expect(await third.response?.text()).toBe("Retry later\n");
    expect(store.get(`rack::attack:${Math.trunc(1_800_000_001 / 64)}:/ip:/p/2:203.0.113.7`)).toBe(2);
  });

  it("lowercases the discriminator", async () => {
    await countThrottles(req("2001:DB8::1"), tiers);

    expect([...store.keys()][0]).toContain("2001:db8::1");
  });

  it("does not count a loopback client", async () => {
    const counted = await countThrottles(req("127.0.0.1"), tiers);

    expect(counted.response).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe("throttled", () => {
  const tiers = throttleByIp("/p", 5, 30, 1);

  it("counts a request Node answers once", async () => {
    const incoming = new Request("http://example.com/p", { headers: headers("203.0.113.7") });

    await throttled(incoming, tiers, () => Promise.resolve(new Response("ok")));

    expect([...store.values()]).toEqual([1]);
  });

  it("uncounts a request that was handed to Rails, which counts it itself", async () => {
    vi.stubEnv("RAILS_ORIGIN", "http://127.0.0.1:1");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("rails")));
    const incoming = new Request("http://example.com/p", { headers: headers("203.0.113.7") });

    await throttled(incoming, tiers, () => forwardToRails(incoming));

    expect([...store.values()]).toEqual([0]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
