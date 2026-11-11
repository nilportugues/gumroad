import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ calls: [] as string[][], counter: 0 }));

vi.mock("./redis.ts", () => ({
  getRedis: () => ({
    pipeline: () => {
      const queued: string[][] = [];
      const pipeline = {
        incrby: (key: string, by: number) => (queued.push(["incrby", key, String(by)]), pipeline),
        expire: (key: string, seconds: number) => (queued.push(["expire", key, String(seconds)]), pipeline),
        decr: (key: string) => (queued.push(["decr", key]), pipeline),
        exec: async () => {
          redis.calls.push(...queued);
          return queued.map(() => [null, ++redis.counter]);
        },
      };
      return pipeline;
    },
  }),
}));

import { THROTTLE_RULES } from "./rack-attack-rules.ts";
import {
  releaseThrottleCounts,
  throttleIdentity,
  throttleName,
  throttleRequest,
  tiersOf,
  withThrottleScope,
} from "./rack-attack.ts";

describe("Rack::Attack counter", () => {
  beforeEach(() => {
    redis.calls = [];
    redis.counter = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
  });

  it("names a regexp rule with Regexp#to_s and the lower-case method", () => {
    expect(throttleName(THROTTLE_RULES.commentCreate)).toBe(String.raw`/ip:(?-mix:\A\/posts\/.+\/comments\z):post`);
    expect(throttleName(THROTTLE_RULES.chatMessageCreate)).toBe(
      String.raw`/ip/period:(?-mix:\A\/communities\/[^\/]+\/chat_messages\z):post`,
    );
  });

  it("builds the exponential tiers: rpm times level over 8 ** level seconds", () => {
    expect(tiersOf(THROTTLE_RULES.commentCreate).map(({ limit, period }) => [limit, period])).toEqual([
      [5, 60],
      [10, 64],
      [15, 512],
      [20, 4096],
      [25, 32_768],
    ]);
    expect(tiersOf(THROTTLE_RULES.chatMessageCreate)).toHaveLength(1);
  });

  it("counts under rack::attack:<window>:<name>:<path>:<ip> and expires one second past the window", async () => {
    const outcome = await throttleRequest([THROTTLE_RULES.commentCreate], {
      pathname: "/posts/p1/comments",
      method: "POST",
      ip: "203.0.113.5",
    });
    expect(outcome).toEqual({ throttled: false });
    const epoch = Date.parse("2026-01-01T00:00:10Z") / 1000;
    const key = `rack::attack:${Math.floor(epoch / 60)}:${throttleName(THROTTLE_RULES.commentCreate)}:/posts/p1/comments:203.0.113.5`;
    expect(redis.calls[0]).toEqual(["incrby", key, "1"]);
    expect(redis.calls[1]).toEqual(["expire", key, String(60 - (epoch % 60) + 1)]);
  });

  it("throttles past the limit with the time left in the window", async () => {
    redis.counter = 5;
    const outcome = await throttleRequest([THROTTLE_RULES.commentCreate], {
      pathname: "/posts/p1/comments",
      method: "POST",
      ip: "203.0.113.5",
    });
    expect(outcome).toEqual({ throttled: true, retryAfter: 50 });
  });

  it("skips localhost, other methods and other paths", async () => {
    const rules = [THROTTLE_RULES.commentCreate];
    const base = { pathname: "/posts/p1/comments", method: "POST", ip: "203.0.113.5" };
    expect(await throttleRequest(rules, { ...base, ip: "127.0.0.1" })).toEqual({ throttled: false });
    expect(await throttleRequest(rules, { ...base, method: "GET" })).toEqual({ throttled: false });
    expect(await throttleRequest(rules, { ...base, pathname: "/posts/p1" })).toEqual({ throttled: false });
    expect(redis.calls).toEqual([]);
  });

  it("prefers CF-Connecting-IP and treats an unknown address as localhost", () => {
    expect(throttleIdentity(new Headers({ "cf-connecting-ip": "198.51.100.1" }), "203.0.113.5")).toBe("198.51.100.1");
    expect(throttleIdentity(new Headers(), null)).toBe("127.0.0.1");
  });

  it("uncounts what the scope incremented", async () => {
    await withThrottleScope(async () => {
      await throttleRequest([THROTTLE_RULES.chatMessageCreate], {
        pathname: "/communities/c/chat_messages",
        method: "POST",
        ip: "203.0.113.5",
      });
      await releaseThrottleCounts();
    });
    expect(redis.calls.filter(([command]) => command === "decr")).toHaveLength(1);
  });
});
