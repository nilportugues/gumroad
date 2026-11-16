import { describe, expect, it } from "vitest";

import { Refunds, jsonDataForAttr, retainedFeeCents, rubyToI } from "./refund.ts";

const refund = (json_data: string | null) => Refunds.load({ id: 1n, json_data } as never);

describe("Refund json_data readers", () => {
  it("reads a missing or blank json_data as an empty hash", () => {
    expect(jsonDataForAttr(refund(null), "note")).toBeNull();
    expect(jsonDataForAttr(refund(""), "note")).toBeNull();
    expect(retainedFeeCents(refund(null))).toBe(0);
  });

  it("returns nil for a blank value and the value otherwise, as json_data_for_attr does", () => {
    const record = refund(JSON.stringify({ a: false, b: "", c: 0, d: "x", e: [], f: null, g: { h: 1 } }));
    expect(["a", "b", "c", "d", "e", "f", "g"].map((key) => jsonDataForAttr(record, key))).toEqual([null, null, 0, "x", null, null, { h: 1 }]);
  });

  it("refuses a json_data that is not a hash", () => {
    expect(() => jsonDataForAttr(refund("[1]"), "a")).toThrow("json_data must be a hash");
    expect(() => jsonDataForAttr(refund('"x"'), "a")).toThrow("json_data must be a hash");
  });

  it("converts with Object#to_i", () => {
    expect([30, 30.9, -2.5, "30", " 12abc", "1_000", "1__0", "abc", "", null, "1.9"].map(rubyToI)).toEqual([30, 30, -2, 30, 12, 1000, 1, 0, 0, 0, 1]);
    expect(() => rubyToI(true)).toThrow("undefined method 'to_i' for true");
    expect(() => rubyToI([])).toThrow("undefined method 'to_i' for an instance of Array");
  });
});
