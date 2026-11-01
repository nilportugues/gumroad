import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { audienceRange } from "./audience.ts";

const NOW = new Date("2026-11-01T03:30:00Z");
const range = (queryString: string) => audienceRange({ queryString }, NOW);
const LAST_30_DAYS = { startDate: "2026-10-03", endDate: "2026-11-01" };

describe("audienceRange", () => {
  it("reads from and to", () => {
    expect(range("from=2026-10-05&to=2026-10-12")).toEqual({ startDate: "2026-10-05", endDate: "2026-10-12" });
    expect(range("to=2026-10-12&from=2026-10-05T23:00:00-07:00")).toEqual({ startDate: "2026-10-05", endDate: "2026-10-12" });
  });

  it("falls back to the last 30 days, in UTC, when either end is missing or not a date", () => {
    expect(range("")).toEqual(LAST_30_DAYS);
    expect(range("from=2026-10-05")).toEqual(LAST_30_DAYS);
    expect(range("from[]=2026-10-05&to=2026-10-12")).toEqual(LAST_30_DAYS);
    expect(range("from=yesterday-ish&to=x")).toEqual(LAST_30_DAYS);
    expect(range("from=&to=")).toEqual(LAST_30_DAYS);
  });

  it("ends a range that stops before it starts on its start", () => {
    expect(range("from=2026-10-12&to=2026-10-05")).toEqual({ startDate: "2026-10-12", endDate: "2026-10-12" });
  });

  it("hands back what Ruby may read differently", () => {
    for (const query of ["from=Oct 5 2026&to=2026-10-12", "from=2026-02-31&to=2026-10-12", "from=2026-10-05&to=10/12/2026", "from=2026-10-31T01:00:00+14:00&to=2026-10-30T20:00:00Z"]) {
      expect(() => range(query), query).toThrow(HandBackToRails);
    }
  });
});
