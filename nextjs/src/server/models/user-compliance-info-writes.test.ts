import { describe, expect, it } from "vitest";

import { birthdayUnderMinimumAge } from "./user-compliance-info-writes.ts";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("birthdayUnderMinimumAge", () => {
  it("is false without a birthday", () => {
    expect(birthdayUnderMinimumAge(null, NOW)).toBe(false);
  });

  it("is true for a birthday less than thirteen years ago", () => {
    expect(birthdayUnderMinimumAge(new Date("2013-06-16T00:00:00Z"), NOW)).toBe(true);
  });

  it("is false for a birthday thirteen years ago or more", () => {
    expect(birthdayUnderMinimumAge(new Date("2013-06-15T00:00:00Z"), NOW)).toBe(false);
    expect(birthdayUnderMinimumAge(new Date("1990-01-01T00:00:00Z"), NOW)).toBe(false);
  });
});
