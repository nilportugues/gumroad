import { describe, expect, it } from "vitest";

import { chargebackRateReserveCents, payableCentsUnderReserve } from "./payouts.ts";

// Vectors from spec/business/payments/payouts/chargeback_rate_payout_reserve_spec.rb and the reserve examples of
// spec/helpers/payouts_helper_spec.rb (balance rows dated 2015-02-24 onwards, $100 minimum).
const row = (id: number, day: number, cents: number) => ({ id, date: new Date(Date.UTC(2015, 1, day)), amount_cents: cents });
const MINIMUM = 100_00;

describe("chargebackRateReserveCents", () => {
  it("holds 25 percent, rounding up so a payout cannot send more than 75 percent", () => {
    expect(chargebackRateReserveCents(0)).toBe(0);
    expect(chargebackRateReserveCents(100_00)).toBe(25_00);
    expect(chargebackRateReserveCents(100_01)).toBe(25_01);
  });

  it("holds nothing for a negative balance", () => {
    expect(chargebackRateReserveCents(-5)).toBe(0);
  });
});

describe("payableCentsUnderReserve", () => {
  it("pays the whole-row prefix under the cap: four $100 rows pay $300 and reserve $100", () => {
    const rows = [24, 25, 26, 27].map((day, i) => row(i + 1, day, 100_00));
    expect(payableCentsUnderReserve(rows, chargebackRateReserveCents(400_00), MINIMUM)).toBe(300_00);
  });

  it("leaves the whole-row leftover waiting: three $100 rows pay $200", () => {
    const rows = [24, 25, 26].map((day, i) => row(i + 1, day, 100_00));
    expect(payableCentsUnderReserve(rows, chargebackRateReserveCents(300_00), MINIMUM)).toBe(200_00);
  });

  it("pays nothing when the fitting prefix misses the minimum ($60 + $70)", () => {
    expect(payableCentsUnderReserve([row(1, 24, 60_00), row(2, 25, 70_00)], chargebackRateReserveCents(130_00), MINIMUM)).toBe(0);
  });

  it("pays nothing when the oldest row does not fit under the cap ($60 + $200)", () => {
    expect(payableCentsUnderReserve([row(1, 24, 60_00), row(2, 25, 200_00)], chargebackRateReserveCents(260_00), MINIMUM)).toBe(0);
  });

  it("pays nothing when one row is larger than the cap", () => {
    expect(payableCentsUnderReserve([row(1, 24, 400_00)], chargebackRateReserveCents(400_00), MINIMUM)).toBe(0);
  });

  it("selects by date then id and stops at the first row that does not fit", () => {
    const rows = [row(3, 26, 50_00), row(1, 25, 100_00), row(2, 25, 300_00)];
    // cap = $450 - $112.50 = $337.50: $100 fits, the $300 row stops the scan before the later $50 row.
    expect(payableCentsUnderReserve(rows, chargebackRateReserveCents(450_00), MINIMUM)).toBe(100_00);
    expect(payableCentsUnderReserve(rows, 0, MINIMUM)).toBe(450_00);
  });

  it("skips rows that are not positive", () => {
    expect(payableCentsUnderReserve([row(1, 24, -50_00), row(2, 25, 200_00), row(3, 26, 100_00)], 0, MINIMUM)).toBe(200_00);
  });
});
