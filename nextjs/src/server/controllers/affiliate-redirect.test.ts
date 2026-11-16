import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { mergeQueries } from "./affiliate-redirect.ts";
import type { RailsRequest } from "./rails-request.ts";

const request = (queryString: string) => ({ queryString }) as RailsRequest;

// Each case is what Addressable::URI answered for the same destination and request query (the queries of AffiliateRedirectController#redirect_url).
describe("mergeQueries", () => {
  it.each([
    ["https://example.com/l/abc", "x=1&y=a%20b", "https://example.com/l/abc?x=1&y=a%20b"],
    ["https://example.com/l/abc?z", "x=1&y=a+b", "https://example.com/l/abc?x=1&y=a%20b&z"],
    ["https://example.com/l/abc?z=", "x&y", "https://example.com/l/abc?x&y&z="],
    ["https://example.com/l/abc", "x=1&x=2", "https://example.com/l/abc?x=2"],
    ["https://example.com/l/abc", "x[]=1&x[]=2", "https://example.com/l/abc?x%5B%5D=2"],
    ["https://example.com/l/abc#frag", "q=%C3%A9&r=%2F", "https://example.com/l/abc?q=%C3%A9&r=%2F#frag"],
    ["https://example.com/l/abc", "B=1&a=2&_=3&1=2", "https://example.com/l/abc?1=2&B=1&_=3&a=2"],
    ["https://example.com/l/abc", "a=b=c&d=", "https://example.com/l/abc?a=b%3Dc&d="],
    ["https://example.com/l/abc", "a=1;b=2", "https://example.com/l/abc?a=1%3Bb%3D2"],
    ["https://example.com/l/abc", "=1&b=2", "https://example.com/l/abc?=1&b=2"],
    ["https://example.com/l/abc", "a=%zz", "https://example.com/l/abc?a=%25zz"],
    ["https://example.com/l/abc?a=1", "a=2", "https://example.com/l/abc?a=2"],
    ["products/foo", "a=2", "/products/foo?a=2"],
    ["https://example.com/l/abc", "a=*'()!~", "https://example.com/l/abc?a=%2A%27%28%29%21~"],
  ])("merges %s with %s", (destination, query, expected) => {
    expect(mergeQueries(destination, request(query), "1", false)).toBe(expected);
  });

  it("adds the affiliate id when the affiliate has a destination url", () => {
    expect(mergeQueries("https://example.com/l/abc?from=affiliate", request("b=2"), "805306368", true)).toBe("https://example.com/l/abc?affiliate_id=805306368&b=2&from=affiliate");
  });

  it("leaves a destination without a query alone", () => {
    expect(mergeQueries("https://example.com/l/abc", request(""), "1", false)).toBe("https://example.com/l/abc");
  });

  it("hands an empty query pair back to Rails", () => {
    expect(() => mergeQueries("https://example.com/l/abc", request("a=1&&b=2"), "1", false)).toThrow(HandBackToRails);
  });
});
