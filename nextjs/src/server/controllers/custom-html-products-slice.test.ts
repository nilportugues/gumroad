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
    ["010", 8n],
    ["-010", -8n],
    ["0_7", 7n],
    ["0x1A", 26n],
    ["0b11", 3n],
    ["0o17", 15n],
    ["0d19", 19n],
    ["1_000", 1000n],
    [" 5\n", 5n],
  ])("reads %s", (value, expected) => {
    expect(integerParam(value)).toBe(expected);
  });

  it.each([[undefined], [""], ["abc"], ["x1"], ["08"], ["1__0"], ["0x"], ["1.5"], ["-"], ["5abc"], ["- 1"], ["1_"]])(
    "reads %s as nil",
    (value) => {
      expect(integerParam(value)).toBeNull();
    },
  );

  it("hands back text with a null byte", () => {
    expect(() => integerParam("1\u00002")).toThrow(HandBackToRails);
  });

  it("hands back a list or hash", () => {
    expect(() => integerParam(["1"])).toThrow(HandBackToRails);
  });
});
