import { describe, expect, it } from "vitest";

import { Base32Error, totpAt } from "./rotp.ts";

// RFC 6238 appendix B's SHA-1 seed, base32-encoded; ROTP keeps the last 6 of its 8 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totpAt", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("matches RFC 6238 at %i", (seconds, code) => {
    expect(totpAt(RFC_SECRET, new Date(seconds * 1000))).toBe(code);
  });

  it("decodes lowercase and padded secrets as ROTP does", () => {
    expect(totpAt("gezdgnbvgy3tqojqgezdgnbvgy3tqojq==", new Date(59_000))).toBe("287082");
  });

  it("raises ROTP's Base32Error on a character outside the alphabet", () => {
    expect(() => totpAt("ABC1", new Date(0))).toThrow(new Base32Error("Invalid Base32 Character - '1'"));
  });
});
