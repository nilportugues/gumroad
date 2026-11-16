import { describe, expect, it } from "vitest";

import { formattedDate } from "./followers.ts";

describe("formattedDate", () => {
  it("writes Follower#as_json's formatted_confirmed_on in UTC", () => {
    expect(formattedDate(new Date("2025-03-09T22:00:00Z"))).toBe("March 9, 2025");
    expect(formattedDate(new Date("2025-01-02T15:04:05Z"))).toBe("January 2, 2025");
    expect(formattedDate(new Date("2025-12-31T23:59:59Z"))).toBe("December 31, 2025");
  });
});
