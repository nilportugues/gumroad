// CustomDomain#certificate_domain_valid? (app/models/custom_domain.rb). The settings_mutations_signed_in_spec.rb examples under "custom
// domain" record Rails' answer for a hyphen label, an empty label, an underscore, an IP address and a bare suffix; the rest are the
// accepted shapes.
import { describe, expect, it } from "vitest";

import { certificateDomainValid, isIpAddress } from "./custom-domain.ts";

describe("certificateDomainValid", () => {
  it.each([
    "store.example.com",
    "shop.example.org",
    "a-b.example.com",
    "www.example.co.uk",
    "xn--bcher-kva.example.com",
  ])("accepts %s", (domain) => expect(certificateDomainValid(domain)).toBe(true));

  it.each([
    ["a label starting with a hyphen", "-shop.example.com"],
    ["a label ending with a hyphen", "shop-.example.com"],
    ["an empty label", "shop..example.com"],
    ["a trailing dot", "shop.example.com."],
    ["an underscore", "my_shop.example.com"],
    ["a space", "shop example.com"],
    ["an IP address", "203.0.113.7"],
    ["a bare public suffix", "com"],
    ["a blank name", ""],
    ["no name", null],
  ])("refuses %s", (_label, domain) => expect(certificateDomainValid(domain)).toBe(false));
});

describe("isIpAddress", () => {
  it("accepts dotted quads of 0-255 and refuses zero-filled, short and out-of-range ones", () => {
    expect(isIpAddress("0.0.0.0")).toBe(true);
    expect(isIpAddress("255.255.255.255")).toBe(true);
    expect(isIpAddress("010.1.1.1")).toBe(false);
    expect(isIpAddress("256.1.1.1")).toBe(false);
    expect(isIpAddress("1.2.3")).toBe(false);
    expect(isIpAddress("a.b.c.d")).toBe(false);
  });
});
