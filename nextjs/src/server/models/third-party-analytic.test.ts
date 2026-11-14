import { describe, expect, it } from "vitest";

import { RubyFloat } from "./concerns/ruby-values.ts";
import { nullable } from "./third-party-analytic.ts";

describe("nullable", () => {
  it("casts a snippet param like a string column", () => {
    expect(nullable(undefined)).toBeNull();
    expect(nullable(null)).toBeNull();
    expect(nullable("code")).toBe("code");
    expect(nullable(1234)).toBe("1234");
    expect(nullable(true)).toBe("1");
    expect(nullable(false)).toBe("0");
    expect(nullable(true, "text")).toBe("t");
    expect(nullable(false, "text")).toBe("f");
  });

  it("casts a float through Float#to_s and an integer past 2**53 to its digits", () => {
    expect(nullable(new RubyFloat(1.5))).toBe("1.5");
    expect(nullable(new RubyFloat(2))).toBe("2.0");
    expect(nullable(12345678901234567890n)).toBe("12345678901234567890");
  });
});
