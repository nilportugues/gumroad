import { crc32 } from "node:zlib";

import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import golden from "./__fixtures__/flipper.golden.json" with { type: "json" };
import {
  evaluateFeature,
  isFeatureEnabled,
  parseGateValues,
  readFeatureDoc,
  resetFlipperStateForTesting,
  UnsupportedFlipperGateError,
  userActor,
} from "./flipper.ts";

vi.mock("./error-reporting", () => ({ notifyError: vi.fn() }));

// Vectors were produced by flipper 1.3.0 + flipper-redis 1.3.0 (generators/flipper.rb).
const store = golden.redis as Record<string, Record<string, string> | string[]>;

function fakeRedis(read: (key: string) => Promise<Record<string, string>>): Redis {
  return { hgetall: read } as unknown as Redis;
}

const goldenRedis = fakeRedis(async (key) => {
  const value = store[key];
  return value && !Array.isArray(value) ? { ...value } : {};
});

describe("Flipper parity with Ruby", () => {
  beforeEach(() => resetFlipperStateForTesting());

  it.each(Object.entries(golden.crc32))("matches Zlib.crc32(%j)", (input, expected) => {
    expect(crc32(Buffer.from(input, "utf8"))).toBe(expected);
  });

  describe.each(Object.entries(golden.results))("%s", (feature, expected) => {
    it("answers enabled? for every actor set exactly as Flipper does", async () => {
      const actual = await Promise.all(
        golden.actor_sets.map((ids) => isFeatureEnabled(feature, ids, { redis: goldenRedis })),
      );
      expect(actual).toEqual(expected);
    });
  });

  it("keeps slashes in actor ids stored in the hash field", () => {
    expect(parseGateValues(store.actors as Record<string, string>).actors).toEqual(
      new Set(["User;1", "User;42", "browser_guid:abc/def"]),
    );
  });

  it("formats User actors like Flipper::Identifier", () => {
    expect(userActor(42n)).toBe("User;42");
  });

  it("refuses expression gates rather than guessing", () => {
    const values = parseGateValues({ expression: JSON.stringify({ Equal: [{ Property: ["plan"] }, "pro"] }) });
    expect(() => evaluateFeature("x", values, "User;1")).toThrow(UnsupportedFlipperGateError);
  });

  it("refuses auto_marketing with an actor, which Rails routes to Marketing::Eligibility", async () => {
    await expect(isFeatureEnabled("auto_marketing", "User;1", { redis: goldenRedis })).rejects.toThrow(
      UnsupportedFlipperGateError,
    );
  });

  it("memoizes gate values per request when given a memo", async () => {
    const hgetall = vi.fn(async () => ({ boolean: "true" }));
    const memo = new Map();
    await isFeatureEnabled("f", undefined, { redis: fakeRedis(hgetall), memo });
    await isFeatureEnabled("f", "User;1", { redis: fakeRedis(hgetall), memo });
    expect(hgetall).toHaveBeenCalledTimes(1);
  });
});

describe("RedisFailOpen", () => {
  beforeEach(() => resetFlipperStateForTesting());

  it("serves the last value read when Redis fails", async () => {
    let fail = false;
    const redis = fakeRedis(async () => {
      if (fail) throw new Error("ECONNRESET");
      return { boolean: "true" };
    });
    expect(await isFeatureEnabled("tax_collection", undefined, { redis })).toBe(true);
    fail = true;
    expect(await isFeatureEnabled("tax_collection", undefined, { redis })).toBe(true);
  });

  it("raises for a feature it has never read", async () => {
    const redis = fakeRedis(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(readFeatureDoc("never_read", redis)).rejects.toThrow("ECONNRESET");
  });
});
