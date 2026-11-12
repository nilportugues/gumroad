import { describe, expect, it } from "vitest";

import { priceCentsFromUnits } from "./price-units.ts";

describe("priceCentsFromUnits", () => {
  it("scales a decimal amount to cents and rounds half up", () => {
    expect(priceCentsFromUnits("5", "usd")).toBe(500);
    expect(priceCentsFromUnits("4.995", "usd")).toBe(500);
    expect(priceCentsFromUnits(".5", "usd")).toBe(50);
    expect(priceCentsFromUnits("5.", "usd")).toBe(500);
  });

  it("keeps a single unit currency unscaled", () => {
    expect(priceCentsFromUnits("500", "jpy")).toBe(500);
    expect(priceCentsFromUnits("500.5", "jpy")).toBe(501);
  });

  it("rejects what Rails reads as an invalid amount and hands signs back", () => {
    expect(priceCentsFromUnits("five", "usd")).toBeNull();
    expect(priceCentsFromUnits("99999999999", "usd")).toBeNull();
    expect(priceCentsFromUnits("-1", "usd")).toBe("unsupported");
  });
});
