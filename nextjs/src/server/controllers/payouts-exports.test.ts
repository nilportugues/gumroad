import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { externalIdsOf } from "./payouts-exports.ts";

describe("Payouts::ExportsController#create payout ids", () => {
  it("wraps a single id and passes a list through", () => {
    expect(externalIdsOf("abc=")).toEqual(["abc="]);
    expect(externalIdsOf(["abc=", "def="])).toEqual(["abc=", "def="]);
  });

  it("reads an absent or null param as no ids", () => {
    expect(externalIdsOf(undefined)).toEqual([]);
    expect(externalIdsOf(null)).toEqual([]);
  });

  it("hands back ids that are numbers, hashes or nested lists", () => {
    for (const param of [123, [123], { a: "b" }, [["abc="]], ["abc=", null]])
      expect(() => externalIdsOf(param)).toThrow(HandBackToRails);
  });
});
