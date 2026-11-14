import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";

import { churnParams, parseRailsDate } from "./churn.ts";

describe("parseRailsDate with an array param", () => {
  it("is nil when the inspect string holds no digit or day or month name", () => {
    expect(parseRailsDate([""])).toBeNull();
    expect(parseRailsDate(["abc", "xyz"])).toBeNull();
  });

  it("hands back when Date._parse might find a date", () => {
    expect(() => parseRailsDate(["2024-01-01"])).toThrow(HandBackToRails);
    expect(() => parseRailsDate(["Monday"])).toThrow(HandBackToRails);
    expect(() => parseRailsDate(["a\\b"])).toThrow(HandBackToRails);
  });

  it("reads from[]= through churnParams", () => {
    expect(churnParams({ queryString: "from[]=&to=2024-01-31" })).toEqual({ startDate: null, endDate: "2024-01-31" });
  });
});
