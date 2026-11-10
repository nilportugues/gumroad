import { describe, expect, it } from "vitest";

import { rubyStringToBigInt } from "./ruby-numeric.ts";

describe("rubyStringToBigInt", () => {
  it("keeps every digit of a value beyond 2**53", () => {
    expect(rubyStringToBigInt("9007199254740993")).toBe(9007199254740993n);
    expect(rubyStringToBigInt("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
  });

  it("reads a sign, leading whitespace, underscores between digits and ignores trailing text", () => {
    expect(rubyStringToBigInt("-9007199254740993")).toBe(-9007199254740993n);
    expect(rubyStringToBigInt("+7")).toBe(7n);
    expect(rubyStringToBigInt("  \t12_345 sales")).toBe(12345n);
    expect(rubyStringToBigInt("1__2")).toBe(1n);
    expect(rubyStringToBigInt("12_")).toBe(12n);
  });

  it("reads text without a leading integer as zero", () => {
    expect(rubyStringToBigInt("abc")).toBe(0n);
    expect(rubyStringToBigInt("")).toBe(0n);
    expect(rubyStringToBigInt("_5")).toBe(0n);
    expect(rubyStringToBigInt("-0")).toBe(0n);
  });
});
