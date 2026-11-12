import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode, Base32Error, provisioningUri, randomSecret, totpAt, verifyTotp } from "./rotp.ts";

describe("base32Encode", () => {
  it("encodes RFC 4648 vectors without padding and round-trips through base32Decode", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, index) => 255 - index * 11));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("draws 32-character secrets", () => {
    expect(randomSecret()).toMatch(/^[A-Z2-7]{32}$/u);
  });
});

describe("provisioningUri", () => {
  it("builds the otpauth URI ROTP writes for an issuer and an account", () => {
    expect(provisioningUri("JBSWY3DPEHPK3PXP", "a+b@example.com", "Gumroad")).toBe(
      "otpauth://totp/Gumroad:a%2Bb%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Gumroad",
    );
  });

  it("percent-encodes what ERB::Util.url_encode does and writes colons as underscores", () => {
    expect(provisioningUri("ABC", "it's:me (x)@example.com ", "Gumroad")).toBe(
      "otpauth://totp/Gumroad:it%27s_me%20%28x%29%40example.com?secret=ABC&issuer=Gumroad",
    );
  });
});

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
