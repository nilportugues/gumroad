import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { localTimeLabel, parseLocalTime } from "./products-publish-schedules.ts";

const INVALID = "Enter a valid date and time.";
const refusal = (value: unknown, zone = "America/Los_Angeles") => {
  try {
    parseLocalTime(value, zone);
  } catch (error) {
    return error instanceof HandBackToRails ? "hand back" : (error as Error).message;
  }
  return "parsed";
};

describe("parseLocalTime", () => {
  it("refuses what strptime cannot read as a date and time", () => {
    for (const value of [undefined, null, "", 12345, 1.5, true, ["2031-06-15T09:30"], { at: "2031-06-15T09:30" }])
      expect(refusal(value)).toBe(INVALID);
    for (const value of ["tomorrow at noon", "2031-06-15", "09:30", "2031/06/15T09:30"])
      expect(refusal(value)).toBe(INVALID);
  });

  it("hands back a string that has the separators but not the editor's spelling", () => {
    expect(refusal("2031-6-5T9:30")).toBe("hand back");
  });

  it("reads the wall-clock time in the zone", () => {
    expect(parseLocalTime("2031-06-15T09:30", "America/Los_Angeles")).toBe(Date.UTC(2031, 5, 15, 16, 30));
  });
});

describe("localTimeLabel", () => {
  const label = (local: string, zone: string) => localTimeLabel(parseLocalTime(local, zone), zone);

  it("prints the abbreviation tzinfo gives each recorded zone", () => {
    expect(label("2031-01-15T09:30", "Europe/London")).toBe("January 15, 2031 at 9:30 AM GMT");
    expect(label("2031-07-15T09:30", "Europe/London")).toBe("July 15, 2031 at 9:30 AM BST");
    expect(label("2031-07-15T09:30", "Europe/Paris")).toBe("July 15, 2031 at 9:30 AM CEST");
    expect(label("2031-01-15T09:30", "America/Chicago")).toBe("January 15, 2031 at 9:30 AM CST");
    expect(label("2031-01-15T09:30", "Australia/Sydney")).toBe("January 15, 2031 at 9:30 AM AEDT");
    expect(label("2031-01-15T09:30", "Asia/Tokyo")).toBe("January 15, 2031 at 9:30 AM JST");
    expect(label("2031-01-15T09:30", "Asia/Kolkata")).toBe("January 15, 2031 at 9:30 AM IST");
    expect(label("2031-07-15T21:05", "Etc/UTC")).toBe("July 15, 2031 at 9:05 PM UTC");
  });

  it("hands back a zone whose abbreviation is not recorded", () => {
    expect(() => localTimeLabel(Date.UTC(2031, 0, 15), "Europe/Berlin")).toThrow(HandBackToRails);
  });
});
