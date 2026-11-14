import { describe, expect, it } from "vitest";

import { displayableReleaseAtDate, oneMonthFrom } from "./new-page.ts";

describe("oneMonthFrom", () => {
  it("clamps the day to the end of a shorter month, as Time#advance(months: 1) does", () => {
    expect(oneMonthFrom(new Date("2026-01-31T10:00:00Z")).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(oneMonthFrom(new Date("2028-01-31T10:00:00Z")).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(oneMonthFrom(new Date("2026-03-31T00:00:00Z")).toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("rolls into the next year", () => {
    expect(oneMonthFrom(new Date("2026-12-15T08:30:00Z")).toISOString()).toBe("2027-01-15T08:30:00.000Z");
  });
});

describe("displayableReleaseAtDate", () => {
  it("formats the date as %B %-d, %Y in the seller's zone", () => {
    expect(displayableReleaseAtDate(new Date("2026-02-05T12:00:00Z"), "Pacific Time (US & Canada)")).toBe("February 5, 2026");
  });

  it("uses the zone's calendar day, not UTC's", () => {
    const instant = new Date("2026-02-05T23:30:00Z");
    expect(displayableReleaseAtDate(instant, "Pacific Time (US & Canada)")).toBe("February 5, 2026");
    expect(displayableReleaseAtDate(instant, "Tokyo")).toBe("February 6, 2026");
  });

  it("refuses a zone Rails does not know", () => {
    expect(() => displayableReleaseAtDate(new Date(), "Nowhere")).toThrow("Invalid Timezone: Nowhere");
  });
});
