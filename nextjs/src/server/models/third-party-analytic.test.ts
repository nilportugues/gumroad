import { describe, expect, it } from "vitest";

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
});
