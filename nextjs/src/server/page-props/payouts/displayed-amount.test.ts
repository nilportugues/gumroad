import { describe, expect, it } from "vitest";

import { displayedAmount, type PaymentRow } from "./payouts.ts";

const payment = (currency: string | null, cents: number) =>
  ({ currency, amount_cents: cents }) as unknown as PaymentRow;

// Payment#displayed_amount(no_cents_if_whole: false): Money#format(symbol: true, with_currency: currency != "usd").
describe("displayedAmount", () => {
  it("shows a USD payout without the currency code", () => {
    expect(displayedAmount(payment("usd", 123_400))).toBe("$1,234.00");
  });

  it("appends the currency code to a payout in another currency", () => {
    expect(displayedAmount(payment("eur", 1234))).toBe("€12.34 EUR");
    expect(displayedAmount(payment("gbp", 100_000))).toBe("£1,000.00 GBP");
  });

  it("formats a currency without subunits and one with a trailing symbol", () => {
    expect(displayedAmount(payment("jpy", 1234))).toBe("¥1,234 JPY");
    expect(displayedAmount(payment("aed", 1234))).toBe("12.34 د.إ AED");
  });

  it("leaves a missing or unknown currency to Rails", () => {
    expect(() => displayedAmount(payment(null, 1))).toThrow();
    expect(() => displayedAmount(payment("xxq", 1))).toThrow();
  });
});
