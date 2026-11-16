import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

import {
  HandBackToRails,
  pageEnvelope,
  processAction,
  routerRedirect,
  type Rendered,
} from "./application-controller.ts";
import { uncountRackAttack } from "./rack-attack.ts";

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

describe("single Rack::Attack counter for a full page load", () => {
  const DISCOVER_KEY = /:\/ip:\/discover:203\.0\.113\.9$/u;

  it("counts a page once when pageEnvelope builds its envelope", async () => {
    const envelope = await pageEnvelope(request("/discover"));
    expect("renderState" in envelope).toBe(true);
    expect(redis.incrby.filter((key) => DISCOVER_KEY.test(key))).toHaveLength(1);
    expect(redis.incrby).toHaveLength(5);
    expect(redis.decr).toEqual([]);
  });

  it("answers 429 past the limit instead of an envelope", async () => {
    let envelope = await pageEnvelope(request("/discover"));
    for (let index = 0; index < 60; index += 1) envelope = await pageEnvelope(request("/discover"));
    expect("response" in envelope && envelope.response.status).toBe(429);
  });

  it("leaves a net count of zero once the proxy takes the count back to send the request through processAction", async () => {
    const incoming = request("/discover");
    await pageEnvelope(incoming);
    await uncountRackAttack(incoming);
    // The base rule and its four backoff tiers.
    expect(redis.incrby).toHaveLength(5);
    expect(redis.decr).toEqual(redis.incrby);
    expect([...redis.values.values()]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("single Rack::Attack counter for a router-level redirect", () => {
  it("counts GET /purchases once in each of its rules and redirects", async () => {
    const response = await routerRedirect(request("/purchases"), "/library");
    expect(response.status).toBe(301);
    // /ip:/purchases and its four tiers, and the hourly /ip/period:/purchases.
    expect(redis.incrby).toHaveLength(6);
    expect(redis.decr).toEqual([]);
  });

  it("answers 429 past forty requests instead of redirecting", async () => {
    let status = 0;
    for (let index = 0; index < 41; index += 1)
      status = (await routerRedirect(request("/purchases"), "/library")).status;
    expect(status).toBe(429);
  });
});

describe("the only call sites of the counter", () => {
  const root = path.join(process.cwd(), "src");
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [full] : [];
    });
  const callsOf = (name: string) =>
    sources(root).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(new RegExp(`\\b${name}\\(`, "gu"))].map(() => path.relative(root, file)),
    );

  it("counts in processAction, pageEnvelope and routerRedirect and nowhere else", { timeout: 30_000 }, () => {
    const calls = callsOf("countRackAttack").filter((file) => file !== "server/controllers/rack-attack.ts");
    expect(calls).toEqual([
      "server/controllers/application-controller.ts",
      "server/controllers/application-controller.ts",
      "server/controllers/application-controller.ts",
    ]);
  });

  it("is imported only by application-controller.ts and the proxy", () => {
    const importers = sources(root)
      .filter((file) => /from "[^"]*\/rack-attack(\.ts)?"/u.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
      .sort();
    expect(importers).toEqual(["proxy.ts", "server/controllers/application-controller.ts"]);
  });
});
