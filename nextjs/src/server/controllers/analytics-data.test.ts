import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { stripTimestampLocation, timeRange } from "./analytics-data.ts";

const NOW = new Date("2024-03-31T12:00:00Z");
const TRAILING_30_DAYS = { startDate: "2024-03-02", endDate: "2024-03-31" };

describe("stripTimestampLocation", () => {
  it("drops a trailing location and trims", () => {
    expect(stripTimestampLocation("2024-01-05 (Pacific Standard Time)")).toBe("2024-01-05");
  });

  it("returns null for an array param, which has no gsub", () => {
    expect(stripTimestampLocation(["2024-01-05"])).toBeNull();
  });

  it("keeps leading parentheses and the first run after them", () => {
    expect(stripTimestampLocation("(2024-01-05)")).toBe("(2024-01-05)");
    expect(stripTimestampLocation("((a(b")).toBe("((a");
    expect(stripTimestampLocation("(a(b)")).toBe("(a");
    expect(stripTimestampLocation("(")).toBe("(");
  });

  it("hands back a line break", () => {
    expect(() => stripTimestampLocation("2024-01-05\n")).toThrow(HandBackToRails);
  });
});

describe("timeRange", () => {
  it("falls back to the trailing 30 days when either time param is an array", () => {
    expect(timeRange("start_time[]=2024-01-01&end_time=2024-01-31", NOW)).toEqual(TRAILING_30_DAYS);
    expect(timeRange("start_time=2024-01-01&end_time[]=2024-01-31", NOW)).toEqual(TRAILING_30_DAYS);
  });

  it("falls back when a parenthesis leaves nothing parseable", () => {
    expect(timeRange("start_time=2024-01-01&end_time=(%20)", NOW)).toEqual(TRAILING_30_DAYS);
    expect(timeRange("start_time=(&end_time=2024-01-31", NOW)).toEqual(TRAILING_30_DAYS);
  });

  it("parses a range with locations", () => {
    expect(timeRange("start_time=2024-01-01%20(PST)&end_time=2024-01-31%20(PST)", NOW)).toEqual({ startDate: "2024-01-01", endDate: "2024-01-31" });
  });

  it("hands back a leading parenthesis that still holds a date", () => {
    expect(() => timeRange("start_time=2024-01-01&end_time=(2024-01-31)", NOW)).toThrow(HandBackToRails);
  });
});
