import { describe, expect, it } from "vitest";

import { humanize, railsJsonTime, sixMonthsAgo } from "./customer-details.ts";

describe("railsJsonTime", () => {
  it("writes UTC as Z with milliseconds", () => {
    expect(railsJsonTime("UTC", new Date("2026-03-04T05:06:07.089Z"))).toBe("2026-03-04T05:06:07.089Z");
  });

  it("writes a seller zone with its offset at that instant", () => {
    expect(railsJsonTime("Pacific Time (US & Canada)", new Date("2026-01-15T20:00:00.000Z"))).toBe(
      "2026-01-15T12:00:00.000-08:00",
    );
    expect(railsJsonTime("Pacific Time (US & Canada)", new Date("2026-07-15T20:00:00.000Z"))).toBe(
      "2026-07-15T13:00:00.000-07:00",
    );
  });
});

describe("sixMonthsAgo", () => {
  it("keeps the day of the month", () => {
    expect(sixMonthsAgo(new Date("2026-11-11T10:00:00.000Z")).toISOString()).toBe("2026-05-11T10:00:00.000Z");
  });

  it("clamps to the end of a shorter month", () => {
    expect(sixMonthsAgo(new Date("2026-08-31T10:00:00.000Z")).toISOString()).toBe("2026-02-28T10:00:00.000Z");
  });

  it("crosses the year", () => {
    expect(sixMonthsAgo(new Date("2026-03-15T00:00:00.000Z")).toISOString()).toBe("2025-09-15T00:00:00.000Z");
  });
});

describe("humanize", () => {
  it("capitalizes the first word and spaces underscores", () => {
    expect(humanize("delivered")).toBe("Delivered");
    expect(humanize("purchase_installment")).toBe("Purchase installment");
  });
});
