// Addressable::URI#query_values= semantics (addressable 2.9.0, lib/addressable/uri.rb): the pairs are sorted, then each key and value
// is encoded with the UNRESERVED class, so everything outside A-Za-z0-9 - . _ ~ becomes uppercase %XX per UTF-8 byte.
import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "support-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { withQueryValues } from "./support.ts";

describe("withQueryValues", () => {
  it("sorts the keys", () => {
    expect(withQueryValues("https://a.example.com/l/x", { utm_source: "s", utm_campaign: "c", utm_medium: "m" })).toBe(
      "https://a.example.com/l/x?utm_campaign=c&utm_medium=m&utm_source=s",
    );
  });

  it("encodes spaces as %20, never +, and reserved characters per UTF-8 byte in uppercase hex", () => {
    expect(withQueryValues("https://a.example.com", { a: "x y+z&=/?#é€", b: "~-._" })).toBe(
      "https://a.example.com?a=x%20y%2Bz%26%3D%2F%3F%23%C3%A9%E2%82%AC&b=~-._",
    );
  });

  it("encodes keys the same way and keeps an empty value as key=", () => {
    expect(withQueryValues("https://a.example.com", { "k y": "", z: "1" })).toBe("https://a.example.com?k%20y=&z=1");
  });

  it("merges over the URL's own query, decoding it first (+ is a space) and sorting the union, writing a bare key without =, and keeps the fragment", () => {
    expect(withQueryValues("https://a.example.com/p?z=1+2&utm_source=old&flag#top", { utm_source: "new" })).toBe(
      "https://a.example.com/p?flag&utm_source=new&z=1%202#top",
    );
  });

  it("leaves a malformed escape as written and decodes multibyte escapes", () => {
    expect(withQueryValues("https://a.example.com/p?a=100%&b=%C3%A9", { c: "1" })).toBe(
      "https://a.example.com/p?a=100%25&b=%C3%A9&c=1",
    );
  });

  it("sorts uppercase before lowercase and underscore after digits, as Ruby's String#<=> does on bytes", () => {
    expect(withQueryValues("https://a.example.com", { b: "1", B: "2", _a: "3", "1": "4" })).toBe(
      "https://a.example.com?1=4&B=2&_a=3&b=1",
    );
  });
});
