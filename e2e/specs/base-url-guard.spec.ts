import { expect, test } from "@playwright/test";

import { DEFAULT_BASE_URL, isSafeHost, resolveBaseUrl } from "../support/base-url";

test.describe("BASE_URL guard", () => {
  test("defaults to dev lane 1", () => {
    expect(resolveBaseUrl("")).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe("http://localhost:3001");
  });

  for (const url of [
    "http://localhost:3003",
    "http://127.0.0.1:3002",
    "http://seller.localhost:3001",
    "https://example.com",
    "https://shop.example.org",
    "http://app.example.net:8080",
    "http://gumroad.example.test",
  ]) {
    test(`allows ${url}`, () => {
      expect(() => resolveBaseUrl(url)).not.toThrow();
    });
  }

  for (const url of [
    "https://gumroad.com",
    "https://app.gumroad.com",
    "https://staging.gumroad.com",
    "http://localhost.evil.com",
    "https://example.evil.com",
    "https://notexample.com",
    "https://example.com.evil.io",
    "http://192.168.1.10:3000",
    "https://stripe.com",
  ]) {
    test(`refuses ${url}`, () => {
      expect(() => resolveBaseUrl(url)).toThrow(/Refusing to run/u);
    });
  }

  test("refuses non-http protocols and garbage", () => {
    expect(() => resolveBaseUrl("ftp://localhost")).toThrow(/http or https/u);
    expect(() => resolveBaseUrl("not a url")).toThrow(/not a valid URL/u);
  });

  test("isSafeHost is case-insensitive", () => {
    expect(isSafeHost("LOCALHOST")).toBe(true);
    expect(isSafeHost("Example.COM")).toBe(true);
  });
});
