import { describe, expect, it } from "vitest";

import { Base32Error, totpAt, verifyTotp } from "./rotp.ts";

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

describe("verifyTotp", () => {
  it("accepts the current code and the ones inside the drift behind it", () => {
    expect(verifyTotp(RFC_SECRET, "287082", 0, new Date(59_000))).toBe(true);
    // 30 seconds later the same code is still inside a 30-second drift, and 60 seconds later it is not.
    expect(verifyTotp(RFC_SECRET, "287082", 30, new Date(89_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET, "287082", 30, new Date(119_000))).toBe(false);
  });

  it("refuses a blank or wrong code and does not look ahead", () => {
    expect(verifyTotp(RFC_SECRET, "", 30, new Date(59_000))).toBe(false);
    expect(verifyTotp(RFC_SECRET, "123456", 30, new Date(59_000))).toBe(false);
    expect(verifyTotp(RFC_SECRET, "081804", 30, new Date(59_000))).toBe(false);
  });
});
