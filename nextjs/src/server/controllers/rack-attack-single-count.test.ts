import { beforeEach, describe, expect, it, vi } from "vitest";

// A request Node serves is counted once, whichever way it leaves processAction: the INCRBY calls are recorded on a fake Redis.
const redis = vi.hoisted(() => {
  const values = new Map<string, number>();
  const incrby: string[] = [];
  const decr: string[] = [];
  return {
    values,
    incrby,
    decr,
    client: {
      pipeline() {
        const queue: (() => number)[] = [];
        const chain = {
          incrby: (key: string) => {
            queue.push(() => {
              incrby.push(key);
              values.set(key, (values.get(key) ?? 0) + 1);
              return values.get(key)!;
            });
            return chain;
          },
          expire: () => {
            queue.push(() => 1);
            return chain;
          },
          exec: async () => queue.map((run) => [null, run()] as const),
        };
        return chain;
      },
      decr: async (key: string) => {
        decr.push(key);
        values.set(key, (values.get(key) ?? 0) - 1);
      },
    },
  };
});

vi.mock("../infra/redis.ts", async (original) => ({
  ...(await original<typeof import("../infra/redis.ts")>()),
  getRedis: () => redis.client,
  // Whatever else the chain reads from Redis finds nothing.
  getNamespacedRedis: () => new Proxy({}, { get: () => async () => null }),
}));

import { HandBackToRails, processAction, type Rendered } from "./application-controller.ts";

const ok = async (): Promise<Rendered> => ({ status: 200, body: "", contentType: "text/plain" });
const request = (path: string) =>
  new Request(`http://app.test.gumroad.com${path}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });

beforeEach(() => {
  redis.values.clear();
  redis.incrby.length = 0;
  redis.decr.length = 0;
  vi.stubEnv("RAILS_ORIGIN", "http://rails.example.com");
  vi.stubEnv("RAILS_ENV", "test");
  vi.stubEnv("SECRET_KEY_BASE", "single-count-test");
});

describe("single Rack::Attack counter", () => {
  it("calls INCRBY once per rule key when Node answers the request", async () => {
    const response = await processAction(request("/v2/sales?page=11"), {}, ok);
    expect(response.status).toBe(200);
    expect(redis.incrby).toEqual([expect.stringMatching(/:\/api\/v2\/sales:203\.0\.113\.9$/u)]);
    expect(redis.decr).toEqual([]);
  });

  it("leaves a net count of zero when the action hands the request to Rails", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await processAction(request("/v2/sales?page=11"), {}, async () => {
      throw new HandBackToRails("test");
    });
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(redis.incrby).toHaveLength(1);
    expect(redis.decr).toEqual(redis.incrby);
    expect([...redis.values.values()]).toEqual([0]);
    fetched.mockRestore();
  });

  it("answers 429 past the limit without running the action", async () => {
    const action = vi.fn(ok);
    let status = 0;
    for (let index = 0; index < 11; index += 1)
      status = (await processAction(request("/v2/sales?page=11"), {}, action)).status;
    expect(status).toBe(429);
    expect(action).toHaveBeenCalledTimes(10);
  });
});
