import { describe, expect, it } from "vitest";

import { oneMonthBefore } from "./product-reviews.ts";

describe("oneMonthBefore", () => {
  it("keeps the day and the time of day", () => {
    expect(oneMonthBefore(new Date("2026-03-07T20:15:30Z")).toISOString()).toBe("2026-02-07T20:15:30.000Z");
  });

  it("falls back to the last day of a shorter month", () => {
    expect(oneMonthBefore(new Date("2026-03-31T20:00:00Z")).toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(oneMonthBefore(new Date("2024-03-31T20:00:00Z")).toISOString()).toBe("2024-02-29T20:00:00.000Z");
    expect(oneMonthBefore(new Date("2026-05-31T20:00:00Z")).toISOString()).toBe("2026-04-30T20:00:00.000Z");
  });

  it("crosses into the previous year in January", () => {
    expect(oneMonthBefore(new Date("2026-01-31T00:00:00Z")).toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });
});
