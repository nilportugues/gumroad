import { describe, expect, it } from "vitest";

import { rubyRoundHalfUp } from "./ruby-round.ts";

describe("rubyRoundHalfUp", () => {
  it("rounds to two places", () => {
    expect(rubyRoundHalfUp(1234.5678)).toBe(1234.57);
    expect(rubyRoundHalfUp(10.8)).toBe(10.8);
  });

  it("keeps the sign of values that round to zero", () => {
    expect(Object.is(rubyRoundHalfUp(-0.001), -0)).toBe(true);
    expect(Object.is(rubyRoundHalfUp(0), 0)).toBe(true);
  });

  it("rounds negative values away from zero at a half", () => {
    expect(rubyRoundHalfUp(-2.5, 0)).toBe(-3);
    expect(rubyRoundHalfUp(-1.234)).toBe(-1.23);
  });
});
