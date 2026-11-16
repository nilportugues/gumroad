import { afterEach, describe, expect, it, vi } from "vitest";

const hashes = new Map<string, Map<string, number>>();
const redis = {
  multi: () => {
    const calls: (() => number)[] = [];
    const chain = {
      hincrby: (key: string, field: string, count: number) => {
        calls.push(() => {
          const hash = hashes.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + count);
          hashes.set(key, hash);
          return hash.get(field)!;
        });
        return chain;
      },
      expire: () => {
        calls.push(() => 1);
        return chain;
      },
      exec: () => Promise.resolve(calls.map((call) => [null, call()])),
    };
    return chain;
  },
  hmget: (key: string, ...fields: string[]) =>
    Promise.resolve(fields.map((field) => String(hashes.get(key)?.get(field) ?? "")).map((v) => (v === "" ? null : v))),
  hkeys: (key: string) => Promise.resolve([...(hashes.get(key)?.keys() ?? [])]),
  hdel: () => Promise.resolve(0),
};

vi.mock("../infra/redis.ts", () => ({ getRedis: () => redis }));

const { Ratelimit } = await import("./ratelimit.ts");

afterEach(() => {
  hashes.clear();
  vi.useRealTimers();
});

describe("Ratelimit", () => {
  it("counts into the five-second bucket of ratelimit:<key>:<subject>", async () => {
    vi.useFakeTimers({ now: 1_700_000_003_000 });
    const limit = new Ratelimit("DEMO");
    await limit.add("DEMO");
    await limit.add("DEMO");
    expect([...hashes.keys()]).toEqual(["ratelimit:DEMO:DEMO"]);
    expect(hashes.get("ratelimit:DEMO:DEMO")!.get(String(Math.floor(1_700_000_003 / 5)))).toBe(2);
  });

  it("sums the buckets inside the interval and reports a subject at its threshold as exceeded", async () => {
    vi.useFakeTimers({ now: 1_700_000_003_000 });
    const limit = new Ratelimit("DEMO");
    for (let i = 0; i < 3; i += 1) await limit.add("DEMO");
    expect(await limit.count("DEMO", 1)).toBe(3);
    expect(await limit.isExceeded("DEMO", { threshold: 3, interval: 1 })).toBe(true);
    expect(await limit.isExceeded("DEMO", { threshold: 4, interval: 1 })).toBe(false);
  });
});
