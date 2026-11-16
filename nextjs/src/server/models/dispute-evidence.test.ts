// Replays __fixtures__/dispute-evidence-window.golden.json (scripts/golden/dispute-evidence-window.rb):
// the evidence window of dispute_evidence.rb for stamps around the weekend-extension cutover, weekends
// and midnights, each checked at instants either side of its deadline.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hoursLeftInWindow, sellerResponseDueAt, sellerResponseReminderAt, windowOpen } from "./dispute-evidence.ts";

type Golden = {
  cases: { stamp: string; due_at: string; reminder_at: string; at: [string, boolean, number][] }[];
  nil: { due_at: null; reminder_at: null; hours_left: number };
};
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/dispute-evidence-window.golden.json", import.meta.url), "utf8")) as Golden;

describe("DisputeEvidence window", () => {
  for (const c of golden.cases) {
    it(`window opened at ${c.stamp}`, () => {
      const stamp = new Date(c.stamp);
      expect(sellerResponseDueAt(stamp)?.toISOString()).toBe(c.due_at);
      expect(sellerResponseReminderAt(stamp)?.toISOString()).toBe(c.reminder_at);
      for (const [at, open, hoursLeft] of c.at) {
        expect([windowOpen(stamp, new Date(at)), hoursLeftInWindow(stamp, new Date(at))], `at ${at}`).toEqual([open, hoursLeft]);
      }
    });
  }

  it("has no window without a stamp", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    expect(sellerResponseDueAt(null)).toBe(golden.nil.due_at);
    expect(sellerResponseReminderAt(null)).toBe(golden.nil.reminder_at);
    expect(hoursLeftInWindow(null, now)).toBe(golden.nil.hours_left);
    expect(windowOpen(null, now)).toBe(false);
  });
});
