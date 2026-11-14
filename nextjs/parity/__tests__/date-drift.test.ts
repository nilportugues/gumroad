import { describe, expect, it } from "vitest";

import { rebaseFarInstants, shiftOrdinalDates } from "../src/date-drift";
import type { Exchange } from "../src/fixture";

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

describe("rebaseFarInstants", () => {
  const recordedAt = new Date("2026-11-13T10:00:00Z");
  const exchange = (json: unknown, db: unknown) =>
    ({ response: { status: 200, headers: {}, json }, db }) as unknown as Exchange;

  it("re-measures an instant years away from the replay's clock, in the response text and the written rows", () => {
    const later = new Date("2026-11-14T04:30:00Z");
    const rebased = rebaseFarInstants(
      exchange(
        { text: '{"valid_at": "<now+632328h>"}', expires_at: "<now+633068h>" },
        { offer_codes: { inserted: [{ valid_at: "<now+632328h>" }] } },
      ),
      recordedAt,
      later,
    );
    // 2099-01-01T10:00Z is 632310 hours after 2026-11-14T04:30Z (rounded from 632309.5).
    expect(rebased.response.json).toEqual({ text: '{"valid_at": "<now+632310h>"}', expires_at: "<now+633050h>" });
    expect(rebased.db).toEqual({ offer_codes: { inserted: [{ valid_at: "<now+632310h>" }] } });
  });

  it("leaves the tokens of seeded rows and past instants alone", () => {
    const rebased = rebaseFarInstants(
      exchange({ a: "<now-48h>", b: "<now+5h>", c: "<now>" }, {}),
      recordedAt,
      new Date("2026-11-15T00:00:00Z"),
    );
    expect(rebased.response.json).toEqual({ a: "<now-48h>", b: "<now+5h>", c: "<now>" });
  });
});
