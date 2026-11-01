import { describe, expect, it } from "vitest";

import { rubySplitComma } from "./library.ts";

// "a,b".split(",") in Ruby: trailing empty fields are dropped, and an empty string has no fields.
describe("rubySplitComma", () => {
  it.each([
    ["", []],
    ["a", ["a"]],
    ["a,b", ["a", "b"]],
    ["a,,b", ["a", "", "b"]],
    ["a,b,,", ["a", "b"]],
    [",a", ["", "a"]],
    [",", []],
  ])("splits %j", (value, fields) => {
    expect(rubySplitComma(value)).toEqual(fields);
  });
});
