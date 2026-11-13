import { describe, expect, it } from "vitest";

import { timeToken } from "../src/canonical";
import { shiftLiteralInstants, shiftOrdinalDates } from "../src/date-drift";

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

describe("shiftLiteralInstants", () => {
  const recordedAt = new Date("2026-11-13T10:00:00Z");
  const body = '{"valid_at":"2099-01-01T10:00:00Z","expires_at":"2099-02-01T08:00:00+02:00"}';
  const tokens = (shifted: string, now: Date) =>
    Object.values(JSON.parse(shifted) as Record<string, string>).map((instant) => timeToken(new Date(instant), now));

  it("masks the shifted instants as the recording masked the literal ones at any wall-clock time", () => {
    const recorded = tokens(body, recordedAt);
    expect(recorded).toEqual(["<now+632328h>", "<now+633068h>"]);
    // Every minute of two days, including the half-hour boundaries the hour rounding turns on.
    for (let minutes = -60; minutes < 2 * 24 * 60; minutes += 1) {
      const now = new Date(recordedAt.getTime() + minutes * 60_000);
      expect(tokens(shiftLiteralInstants(body, recordedAt, now), now)).toEqual(recorded);
    }
  });

  it("keeps the offset and the fraction the request wrote", () => {
    const now = new Date("2026-11-13T17:41:00Z");
    expect(shiftLiteralInstants('{"a":"2099-02-01T08:00:00+02:00","b":"2099-02-01T08:00:00.5Z"}', recordedAt, now)).toBe(
      '{"a":"2099-02-01T16:00:00+02:00","b":"2099-02-01T16:00:00.5Z"}',
    );
  });

  it("leaves a body without an instant alone", () => {
    expect(shiftLiteralInstants('{"code":"TENOFF"}', recordedAt, new Date())).toBe('{"code":"TENOFF"}');
  });
});
