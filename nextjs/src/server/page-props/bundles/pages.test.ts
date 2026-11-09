import { describe, expect, it } from "vitest";

import { canBeBundle } from "./pages.ts";

// Link flag bits: is_recurring_billing (2) and is_bundle (26), as Link::FLAGS in app/models/link.rb.
const IS_RECURRING_BILLING = 1n << 2n;
const IS_BUNDLE = 1n << 26n;

const product = (flags: bigint, native_type: string | null) => ({ flags, native_type }) as const;

describe("canBeBundle", () => {
  it("accepts a bundle whatever its native type or variant categories", () => {
    expect(canBeBundle(product(IS_BUNDLE | IS_RECURRING_BILLING, "call"), true)).toBe(true);
  });

  it("accepts a plain product with no alive variant categories", () => {
    expect(canBeBundle(product(0n, "digital"), false)).toBe(true);
  });

  it("rejects a membership", () => {
    expect(canBeBundle(product(IS_RECURRING_BILLING, "membership"), false)).toBe(false);
  });

  it("rejects a call", () => {
    expect(canBeBundle(product(0n, "call"), false)).toBe(false);
  });

  it("rejects a product with alive variant categories", () => {
    expect(canBeBundle(product(0n, "digital"), true)).toBe(false);
  });

  it("rejects a product without a native type, as SQL's != drops NULL", () => {
    expect(canBeBundle(product(0n, null), false)).toBe(false);
  });
});
