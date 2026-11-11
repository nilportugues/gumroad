import { describe, expect, it } from "vitest";

import { NotPortedError } from "../../models/user.ts";

import { amountRefusal, castBoolean } from "./purchase-writes.ts";
import { fetchPurchase, searchLimit, strippedParam, truthy } from "./purchases.ts";
import { findAdminRoute } from "./registry.ts";

describe("purchase routes", () => {
  it("serves search and lookup before the purchase id route", () => {
    expect(findAdminRoute("GET", "/internal/admin/purchases/search")?.route.pattern).toBe(
      "/internal/admin/purchases/search",
    );
    expect(findAdminRoute("GET", "/api/internal/admin/purchases/lookup")?.route.pattern).toBe(
      "/internal/admin/purchases/lookup",
    );
    expect(findAdminRoute("GET", "/internal/admin/purchases/536870912")?.routeParams).toEqual({ id: "536870912" });
  });

  it("reads a dot in the id as the format separator", () => {
    expect(findAdminRoute("GET", "/internal/admin/purchases/536870912.json")).toBeNull();
  });

  it("serves the member and collection writes as POSTs", () => {
    for (const action of [
      "refund",
      "resend_receipt",
      "refund_taxes",
      "cancel_subscription",
      "block_buyer",
      "unblock_buyer",
      "refund_for_fraud",
    ]) {
      expect(findAdminRoute("POST", `/internal/admin/purchases/42/${action}`)?.routeParams).toEqual({ id: "42" });
      expect(findAdminRoute("GET", `/internal/admin/purchases/42/${action}`)).toBeNull();
    }
    expect(findAdminRoute("POST", "/internal/admin/purchases/resend_all_receipts")).not.toBeNull();
  });

  it("leaves the reassignment to Rails", () => {
    expect(findAdminRoute("POST", "/internal/admin/purchases/reassign")).toBeNull();
  });
});

describe("fetchPurchase", () => {
  it("answers null for an id that is not all digits without touching the database", async () => {
    expect(await fetchPurchase("abc")).toBeNull();
    expect(await fetchPurchase("12a")).toBeNull();
    expect(await fetchPurchase("")).toBeNull();
    expect(await fetchPurchase(undefined)).toBeNull();
  });

  it("hands back a numeric id past 2**53", async () => {
    await expect(fetchPurchase("99999999999999999999")).rejects.toThrow(NotPortedError);
  });
});

describe("searchLimit", () => {
  it("reads the limit like String#to_i and caps it at 25", () => {
    expect(searchLimit("5")).toBe(5);
    expect(searchLimit(" 7abc")).toBe(7);
    expect(searchLimit("1_0")).toBe(10);
    expect(searchLimit("500")).toBe(25);
    expect(searchLimit(3)).toBe(3);
  });

  it("falls back to 25 for a missing, zero, negative or non-numeric limit", () => {
    for (const raw of [undefined, null, "", "0", "-4", "abc"]) expect(searchLimit(raw)).toBe(25);
  });

  it("hands back a limit that is neither text nor a number", () => {
    expect(() => searchLimit(["1"])).toThrow(NotPortedError);
  });
});

describe("amountRefusal", () => {
  it("accepts a missing amount and positive integers", () => {
    for (const raw of [undefined, null, "", "  ", false, "500", 500]) expect(amountRefusal(raw)).toBeNull();
  });

  it("refuses zero, negatives and text that is not digits", () => {
    for (const raw of [0, -5, "0", "00", "-5", "12.5", "5 ", "abc", true, ["1"]])
      expect(amountRefusal(raw)?.status).toBe(422);
  });

  it("hands back a float it cannot tell from an integer", () => {
    expect(() => amountRefusal(12.5)).toThrow(NotPortedError);
  });
});

describe("castBoolean", () => {
  it("casts the way ActiveModel::Type::Boolean does", () => {
    for (const raw of [true, "true", "1", 1, "yes", "anything"]) expect(castBoolean(raw)).toBe(true);
    for (const raw of [false, 0, "0", "f", "F", "false", "FALSE", "off", "OFF"]) expect(castBoolean(raw)).toBe(false);
    for (const raw of [undefined, null, ""]) expect(castBoolean(raw)).toBeNull();
  });
});

describe("truthy and strippedParam", () => {
  it("reads tinyint columns as booleans", () => {
    expect(truthy(1)).toBe(true);
    expect(truthy(true)).toBe(true);
    expect(truthy(1n)).toBe(true);
    expect([truthy(0), truthy(false), truthy(null), truthy(0n)]).toEqual([false, false, false, false]);
  });

  it("strips whitespace and NUL and turns nil into an empty string", () => {
    expect(strippedParam("  a@example.com\0 ")).toBe("a@example.com");
    expect(strippedParam(undefined)).toBe("");
  });
});
