import { describe, expect, it } from "vitest";

import GOLDEN from "./__fixtures__/payout-schedule.golden.json" with { type: "json" };
import {
  addDays,
  currentPayoutEndDate,
  daysBeforeCycleDate,
  displayablePayoutPeriodRange,
  formattedPayoutDate,
  isoDate,
  nextPayoutCycleDate,
  nextPayoutDate,
  ordinalize,
  payoutWeekday,
  type Ledger,
  type PayoutFrequency,
} from "./payout-schedule.ts";

// Recorded from the real User::PayoutSchedule and PayoutsHelper (scripts/golden/payout-schedule.rb).
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("payout schedule", () => {
  it("replays every recorded case", async () => {
    const offsets = GOLDEN.balanceSets as unknown as Record<string, [number, number][]>;
    let checked = 0;
    for (const row of GOLDEN.cases as unknown[][]) {
      const [today, frequency, bankAccountType, balanceSet, paidToday, cycle, next, endDate, ranges] = row as [
        string,
        PayoutFrequency,
        string | null,
        string,
        boolean,
        string | null,
        string | null,
        string | null,
        string[] | null,
      ];
      const day = utc(today);
      const balances = offsets[balanceSet]!.map(([offset, cents]) => [addDays(day, offset), cents] as const);
      const ledger: Ledger = {
        today: day,
        frequency,
        minimumPayoutAmountCents: 1000,
        daysBeforeCycleDate: daysBeforeCycleDate(payoutWeekday({ bankAccountType, payoutsViaPaypal: false })),
        unpaidBalanceCents: async () => balances.reduce((sum, [, cents]) => sum + cents, 0),
        unpaidBalanceCentsUpToDate: async (date) =>
          balances
            .filter(([balanceDate]) => balanceDate.getTime() <= date.getTime())
            .reduce((sum, [, cents]) => sum + cents, 0),
        paidToday: async () => paidToday,
      };
      const label = JSON.stringify(row);
      expect((await nextPayoutCycleDate(ledger))?.toISOString().slice(0, 10) ?? null, label).toBe(cycle);
      const nextDate = await nextPayoutDate(ledger);
      expect(nextDate === null ? null : isoDate(nextDate), label).toBe(next);
      if (nextDate === null) continue;
      const end = await currentPayoutEndDate(ledger);
      expect(isoDate(end), label).toBe(endDate);
      if (ranges) {
        expect(
          [null, addDays(day, -9), day].map((previous) => displayablePayoutPeriodRange(previous, end, day)),
          label,
        ).toEqual(ranges);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("ends the period of a daily seller that falls back to the weekly cycle the day before the payout date", async () => {
    const today = utc("2026-03-04");
    const ledger: Ledger = {
      today,
      frequency: "weekly",
      minimumPayoutAmountCents: 1000,
      daysBeforeCycleDate: 1,
      unpaidBalanceCents: async () => 5000,
      unpaidBalanceCentsUpToDate: async () => 5000,
      paidToday: async () => false,
      dailyFallback: true,
    };
    expect(isoDate((await nextPayoutDate(ledger))!)).toBe("2026-03-05");
    expect(isoDate(await currentPayoutEndDate(ledger))).toBe("2026-03-04");
    expect(isoDate(await currentPayoutEndDate({ ...ledger, dailyFallback: false }))).toBe("2026-02-27");
  });

  it("ordinalizes like ActiveSupport", () => {
    for (const [day, text] of Object.entries(GOLDEN.ordinals as Record<string, string>))
      expect(ordinalize(Number(day))).toBe(text);
    expect(formattedPayoutDate(utc("2026-03-22"))).toBe("March 22nd, 2026");
    expect(formattedPayoutDate(null)).toBe("");
  });
});
