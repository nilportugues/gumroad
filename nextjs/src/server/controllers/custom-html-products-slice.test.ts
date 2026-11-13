import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { integerParam } from "./custom-html-products-slice.ts";

describe("integerParam (Kernel#Integer with exception: false)", () => {
  it.each([
    ["0", 0n],
    ["12", 12n],
    ["+3", 3n],
    ["-4", -4n],
    ["99999999999999999999", 99999999999999999999n],
  ])("reads %s", (value, expected) => {
    expect(integerParam(value)).toBe(expected);
  });

  it.each([[undefined], [""], ["abc"], ["x1"]])("reads %s as nil", (value) => {
    expect(integerParam(value)).toBeNull();
  });

  it.each([["010"], ["0x1A"], ["1_000"], [" 5"], ["1.5"], ["-"], ["5abc"]])("hands back %s", (value) => {
    expect(() => integerParam(value)).toThrow(HandBackToRails);
  });

  it("hands back a list or hash", () => {
    expect(() => integerParam(["1"])).toThrow(HandBackToRails);
  });
});
