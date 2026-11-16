import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { cachedVersion, cachedVersionState, displayableTimeDuration, ruleVersionKey } from "./installment-rule.ts";

// Answers recorded from the real InstallmentRule#displayable_time_duration (Ruby 3.4, ActiveSupport 8.1).
const RUBY_DURATIONS: [number, string, number | string][] = [
  [0, "hour", 0],
  [3599, "hour", 0],
  [3600, "hour", 1],
  [90_000, "day", 1],
  [259_205, "day", 3],
  [604_799, "week", 0],
  [1_814_400, "week", 3],
  [2_629_745, "month", 0],
  [2_629_746, "month", 1],
  [13_148_830, "month", 5],
  [2_592_000, "month", 0],
  [5_184_000, "month", 1],
  [100, "weird", "nil can't be coerced into Integer"],
];

describe("InstallmentRule#displayable_time_duration", () => {
  it.each(RUBY_DURATIONS)("%i seconds as %s", (delay, period, expected) => {
    const rule = { delayed_delivery_time: delay, time_period: period };
    if (typeof expected === "string") expect(() => displayableTimeDuration(rule)).toThrow(expected);
    else expect(displayableTimeDuration(rule)).toBe(expected);
  });

  it("fails on a missing delay", () => {
    expect(() => displayableTimeDuration({ delayed_delivery_time: null, time_period: "hour" })).toThrow("undefined method '/' for nil");
  });
});

const fakeRedis = (values: Record<string, string>) =>
  ({
    get: async (key: string) => values[key] ?? null,
    mget: async (...keys: string[]) => keys.map((key) => values[key] ?? null),
  }) as unknown as Redis;

describe("cached rule version", () => {
  it("reads the version Redis holds, or nil", async () => {
    expect(await cachedVersion(7, fakeRedis({ [ruleVersionKey(7)]: "4" }))).toBe(4);
    expect(await cachedVersion(8, fakeRedis({}))).toBeNull();
  });

  it("reports whether a pending write owns the key", async () => {
    const redis = fakeRedis({ [ruleVersionKey(7)]: "4", "workflow_installment_rule:7:pending_token": "token" });
    expect(await cachedVersionState(7, redis)).toEqual([4, true]);
    expect(await cachedVersionState(8, redis)).toEqual([null, false]);
  });
});
