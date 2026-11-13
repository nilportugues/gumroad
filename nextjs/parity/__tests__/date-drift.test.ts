import { describe, expect, it } from "vitest";

import { shiftOrdinalDates } from "../src/date-drift";

const RECORDED_ON = "2026-11-09";

describe("shiftOrdinalDates", () => {
  it("moves an ordinal date near the recording day", () => {
    expect(shiftOrdinalDates("November 9th, 2026", 1, RECORDED_ON)).toBe("November 10th, 2026");
  });

  it("leaves an ordinal date a spec pinned years away alone", () => {
    expect(shiftOrdinalDates("January 3rd, 2030", 1, RECORDED_ON)).toBe("January 3rd, 2030");
  });

  it("moves a space-padded day and a plain one, keeping the padding of the original", () => {
    expect(shiftOrdinalDates("November  9, 2026", 1, RECORDED_ON)).toBe("November 10, 2026");
    expect(shiftOrdinalDates("November 9, 2026", 1, RECORDED_ON)).toBe("November 10, 2026");
    expect(shiftOrdinalDates("November  1, 2026", 1, RECORDED_ON)).toBe("November  2, 2026");
  });

  it("leaves a long date far from the recording day alone", () => {
    expect(shiftOrdinalDates("March 7, 2031", 1, RECORDED_ON)).toBe("March 7, 2031");
  });

  it("moves a seeded date of birth wherever it lies", () => {
    expect(shiftOrdinalDates({ guardian: { date_of_birth: "1975-03-04" } }, 1, RECORDED_ON)).toEqual({
      guardian: { date_of_birth: "1975-03-05" },
    });
  });
});
