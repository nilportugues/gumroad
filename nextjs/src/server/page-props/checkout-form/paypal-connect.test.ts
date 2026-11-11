import { describe, expect, it } from "vitest";

import { primaryEmail } from "./paypal-connect.ts";

describe("primaryEmail", () => {
  it("reads the key of a parsed object", () => {
    expect(primaryEmail({ primary_email: "seller@example.com" })).toBe("seller@example.com");
  });

  it("answers nothing for an object without the key or with a null one", () => {
    expect(primaryEmail({ merchant_id: "B66YJBBNCRW6L" })).toBeNull();
    expect(primaryEmail({ primary_email: null })).toBeNull();
  });

  it("answers the key itself for text that contains it, as String#[] does", () => {
    expect(primaryEmail("gateway primary_email timeout")).toBe("primary_email");
    expect(primaryEmail("gateway timeout")).toBeNull();
  });

  it("answers nothing for a list, a number, a boolean or no body", () => {
    for (const parsed of [[], [1], 5, true, null, undefined]) expect(primaryEmail(parsed)).toBeNull();
  });
});
