import { describe, expect, it } from "vitest";

import { defaultCurrency } from "./country-currency.ts";

describe("defaultCurrency", () => {
  it("maps the countries Country#default_currency names", () => {
    expect(defaultCurrency("US")).toBe("usd");
    expect(defaultCurrency("GB")).toBe("gbp");
    expect(defaultCurrency("DE")).toBe("eur");
    expect(defaultCurrency("LI")).toBe("chf");
    expect(defaultCurrency("JP")).toBe("jpy");
  });

  it("is nil for a country without a default currency", () => {
    expect(defaultCurrency("BR")).toBeNull();
    expect(defaultCurrency(null)).toBeNull();
  });
});
