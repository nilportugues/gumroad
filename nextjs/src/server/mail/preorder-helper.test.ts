// The shapes customer-mailer.golden.json records (preorder_receipt_*) cover the format; these pin the edges the
// golden cannot: ordinals around the teens, the day a DST change falls on, and the zones that are refused.
import { describe, expect, it } from "vitest";

import { displayableReleaseAtDateAndTime } from "./preorder-helper.ts";
import { MailViewNotPortedError } from "./views.ts";

const PACIFIC = "Pacific Time (US & Canada)";

describe("displayableReleaseAtDateAndTime", () => {
  it("ordinalizes the day like Integer#ordinalize", () => {
    const day = (n: number) => displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 0, n, 20)), PACIFIC);
    expect(day(1)).toBe("January 1st, 12PM PST");
    expect(day(2)).toBe("January 2nd, 12PM PST");
    expect(day(3)).toBe("January 3rd, 12PM PST");
    expect(day(11)).toBe("January 11th, 12PM PST");
    expect(day(12)).toBe("January 12th, 12PM PST");
    expect(day(13)).toBe("January 13th, 12PM PST");
    expect(day(21)).toBe("January 21st, 12PM PST");
    expect(day(22)).toBe("January 22nd, 12PM PST");
    expect(day(23)).toBe("January 23rd, 12PM PST");
    expect(day(24)).toBe("January 24th, 12PM PST");
  });

  it("pads a single-digit hour with a space and shows minutes only when there are some", () => {
    expect(displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 11, 25, 17)), PACIFIC)).toBe(
      "December 25th,  9AM PST",
    );
    expect(displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 11, 25, 17, 5)), PACIFIC)).toBe(
      "December 25th,  9:05AM PST",
    );
    expect(displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 11, 25, 8)), PACIFIC)).toBe(
      "December 25th, 12AM PST",
    );
  });

  it("switches abbreviation with daylight saving time", () => {
    expect(displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 2, 8, 9, 59)), PACIFIC)).toBe(
      "March 8th,  1:59AM PST",
    );
    expect(displayableReleaseAtDateAndTime(new Date(Date.UTC(2026, 2, 8, 10, 0)), PACIFIC)).toBe("March 8th,  3AM PDT");
  });

  it("refuses a zone whose abbreviation comes from tzdata, and a missing or unknown one", () => {
    const instant = new Date(Date.UTC(2026, 11, 25, 17));
    expect(() => displayableReleaseAtDateAndTime(instant, "Kolkata")).toThrow(MailViewNotPortedError);
    expect(() => displayableReleaseAtDateAndTime(instant, null)).toThrow(MailViewNotPortedError);
    expect(() => displayableReleaseAtDateAndTime(instant, "Nowhere")).toThrow(MailViewNotPortedError);
  });
});
