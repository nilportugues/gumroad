import { describe, expect, it } from "vitest";

import { RubyFloat } from "../server/jobs/sidekiq/ruby-json.ts";
import { golden } from "../worker/jobs/__fixtures__/golden.ts";
import { rubyFloatToS, rubyToS } from "./ruby-to-s.ts";

describe("rubyFloatToS matches Float#to_s", () => {
  it.each(golden.float_to_s)("%s", (exact, expected) => {
    expect(rubyFloatToS(Number(exact))).toBe(expected);
  });
});

describe("rubyToS", () => {
  it("formats scalars as Ruby's to_s does", () => {
    expect([null, "a", true, 3, 12345678901234567890n, new RubyFloat(2), 0.5].map(rubyToS)).toEqual(["", "a", "true", "3", "12345678901234567890", "2.0", "0.5"]);
  });

  it("refuses arrays and hashes", () => {
    expect(() => rubyToS([1])).toThrow(/not ported/u);
    expect(() => rubyToS({ a: 1 })).toThrow(/not ported/u);
  });
});
