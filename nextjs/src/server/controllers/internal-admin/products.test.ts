import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { NotPortedError } from "../../models/user.ts";

import { idFromExternalId, pagyMetadata, textParam } from "./products.ts";
import "./product-writes.ts";
import { findAdminRoute } from "./registry.ts";

const saved = { ...process.env };

beforeEach(() => {
  process.env.OBFUSCATE_IDS_CIPHER_KEY = "test-cipher-key";
  process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "1234";
});

afterEach(() => {
  process.env = { ...saved };
});

describe("pagyMetadata", () => {
  it("reports the neighbours of a middle page", () => {
    expect(pagyMetadata(25, 2, 10)).toEqual({ count: 25, items: 10, page: 2, pages: 3, prev: 1, next: 3, last: 3 });
  });

  it("has no previous or next page for an empty list", () => {
    expect(pagyMetadata(0, 1, 10)).toEqual({ count: 0, items: 10, page: 1, pages: 1, prev: null, next: null, last: 1 });
  });

  it("zeroes the items of a page past the last and points back at the last page", () => {
    expect(pagyMetadata(25, 9, 10)).toEqual({ count: 25, items: 0, page: 9, pages: 3, prev: 3, next: null, last: 3 });
  });
});

describe("idFromExternalId", () => {
  it("reads back the id an external id was made from", () => {
    expect(idFromExternalId(encrypt(42))).toBe(42n);
  });

  it("finds nothing for text that does not decrypt or that decrypts to no row id", () => {
    expect(idFromExternalId("not-an-id")).toBeNull();
    expect(idFromExternalId(encrypt("abc"))).toBeNull();
    expect(idFromExternalId(encrypt(-5))).toBeNull();
  });
});

describe("textParam", () => {
  it("hands back a parameter Rails would read as something other than text", () => {
    expect(textParam("a")).toBe("a");
    for (const value of [["a"], { a: 1 }, 5, true]) expect(() => textParam(value)).toThrow(NotPortedError);
  });
});

describe("routes", () => {
  it("registers the five product routes under their verbs", () => {
    const route = (method: string, path: string) => findAdminRoute(method, path)?.route.pattern;
    expect(route("GET", "/internal/admin/products")).toBe("/internal/admin/products");
    expect(route("GET", "/internal/admin/products/abc")).toBe("/internal/admin/products/:id");
    expect(route("GET", "/api/internal/admin/products/abc/files/def/download_url")).toBe(
      "/internal/admin/products/:id/files/:file_id/download_url",
    );
    expect(route("POST", "/internal/admin/products/abc/hold_sales")).toBe("/internal/admin/products/:id/hold_sales");
    expect(route("POST", "/internal/admin/products/abc/release_sales_hold")).toBe(
      "/internal/admin/products/:id/release_sales_hold",
    );
    expect(route("GET", "/internal/admin/products/abc/hold_sales")).toBeUndefined();
  });
});
