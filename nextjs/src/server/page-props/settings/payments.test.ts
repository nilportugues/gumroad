// The two values of the payments page that depend on the day it renders (the replays ignore them).
import { describe, expect, it } from "vitest";

import { creditCreationDate, minDobYear } from "./payments.ts";

describe("creditCreationDate", () => {
  it("is the first of next month once that is past the Australian backtax cutover", () => {
    expect(creditCreationDate(new Date("2026-11-01T09:00:00Z"))).toBe("December 1, 2026");
    expect(creditCreationDate(new Date("2026-12-31T23:59:59Z"))).toBe("January 1, 2027");
  });

  it("never names a date before July 1, 2023", () => {
    expect(creditCreationDate(new Date("2023-02-10T00:00:00Z"))).toBe("July 1, 2023");
  });
});

describe("minDobYear", () => {
  it("subtracts the minimum age from the current year", () => {
    expect(minDobYear(new Date(2026, 5, 15))).toBe(2013);
  });
});
