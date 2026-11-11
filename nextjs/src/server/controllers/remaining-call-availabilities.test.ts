import { describe, expect, it } from "vitest";

import { computeCallAvailabilities, type ComputeInput } from "./remaining-call-availabilities.ts";

// spec/services/product/compute_call_availabilities_service_spec.rb, with the clock at 2015-04-01 00:00 UTC.
const HOUR = 3_600_000;
const NOW = Date.UTC(2015, 3, 1);
const base: ComputeInput = {
  zone: "UTC",
  now: NOW,
  availabilities: [],
  sellerBookings: [],
  productBookingStarts: [],
  minimumNoticeInMinutes: 0,
  maximumCallsPerDay: null,
};

describe("computeCallAvailabilities", () => {
  it("merges overlapping windows and keeps the past part of a window from starting before now", () => {
    const result = computeCallAvailabilities({
      ...base,
      availabilities: [
        { start: NOW - 10 * HOUR, end: NOW + HOUR },
        { start: NOW + HOUR, end: NOW + 2 * HOUR },
      ],
    });
    expect(result).toEqual([{ start: NOW, end: NOW + 2 * HOUR }]);
  });

  it("moves the start up to the minimum notice", () => {
    const result = computeCallAvailabilities({
      ...base,
      minimumNoticeInMinutes: 60,
      availabilities: [{ start: NOW - 10 * HOUR, end: NOW + 2 * HOUR }],
    });
    expect(result).toEqual([{ start: NOW + HOUR, end: NOW + 2 * HOUR }]);
  });

  it("drops a window that ends before the notice period is over", () => {
    expect(
      computeCallAvailabilities({
        ...base,
        minimumNoticeInMinutes: 180,
        availabilities: [{ start: NOW, end: NOW + 2 * HOUR }],
      }),
    ).toEqual([]);
  });

  it("takes bookings out of a window and splits it", () => {
    const result = computeCallAvailabilities({
      ...base,
      availabilities: [{ start: NOW + HOUR, end: NOW + 5 * HOUR }],
      sellerBookings: [{ start: NOW + 2 * HOUR, end: NOW + 3 * HOUR }],
    });
    expect(result).toEqual([
      { start: NOW + HOUR, end: NOW + 2 * HOUR },
      { start: NOW + 3 * HOUR, end: NOW + 5 * HOUR },
    ]);
  });

  describe("with a daily maximum in Pacific time", () => {
    const zone = "Pacific Time (US & Canada)";
    // 2015-04-01 12:00 PDT
    const now = Date.UTC(2015, 3, 1, 19);
    const local = (day: number, hour: number) => Date.UTC(2015, 3, day, hour + 7);
    const booking = (day: number, startHour: number, endHour: number) => ({
      start: local(day, startHour),
      end: local(day, endHour),
    });

    it("keeps the days that still have room and ends a window on the last day with room", () => {
      const result = computeCallAvailabilities({
        zone,
        now,
        minimumNoticeInMinutes: 0,
        maximumCallsPerDay: 1,
        availabilities: [{ start: local(1, 12), end: local(6, 12) }],
        sellerBookings: [booking(2, 12, 13), booking(3, 12, 13), booking(5, 12, 24)],
        productBookingStarts: [local(2, 12), local(3, 12), local(5, 12)],
      });
      expect(result).toEqual([
        { start: local(1, 12), end: local(1, 24) - 1 },
        { start: local(4, 0), end: local(4, 24) - 1 },
        { start: local(6, 0), end: local(6, 12) },
      ]);
    });

    it("drops a window whose every day is full", () => {
      const result = computeCallAvailabilities({
        zone,
        now,
        minimumNoticeInMinutes: 0,
        maximumCallsPerDay: 1,
        availabilities: [{ start: local(2, 9), end: local(2, 17) }],
        sellerBookings: [],
        productBookingStarts: [local(2, 18)],
      });
      expect(result).toEqual([]);
    });

    it("does not count a booking from before today toward the limit", () => {
      const result = computeCallAvailabilities({
        zone,
        now,
        minimumNoticeInMinutes: 0,
        maximumCallsPerDay: 1,
        availabilities: [{ start: local(1, 13), end: local(1, 17) }],
        sellerBookings: [],
        productBookingStarts: [local(1, -5)],
      });
      expect(result).toEqual([{ start: local(1, 13), end: local(1, 17) }]);
    });
  });
});
