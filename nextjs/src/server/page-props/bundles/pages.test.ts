import { describe, expect, it } from "vitest";

import { canBeBundle } from "./pages.ts";

// flag_shih_tzu positions are 1-based: is_recurring_billing is position 2 and is_bundle position 26 in
// app/models/link.rb, so their bits are 1 << 1 and 1 << 25.
const IS_RECURRING_BILLING = 1n << 1n;
const IS_BUNDLE = 1n << 25n;

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
