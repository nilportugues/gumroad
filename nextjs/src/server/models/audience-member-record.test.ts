import { describe, expect, it } from "vitest";

import { compactDetails, detailsValid } from "./audience-member-record.ts";

const follower = { id: 1, created_at: "2025-01-01T12:00:00Z" };
const purchase = { id: 2, product_id: 3, price_cents: 100, created_at: "2025-01-02T12:00:00Z" };

describe("detailsValid", () => {
  it("accepts a follower, purchases or affiliates", () => {
    expect(detailsValid({ follower })).toBe(true);
    expect(detailsValid({ purchases: [purchase] })).toBe(true);
    expect(detailsValid({ affiliates: [{ id: 1, product_id: 2, created_at: "2025-01-01T12:00:00Z" }] })).toBe(true);
  });

  it("rejects details with none of the three, unknown keys and incomplete entries", () => {
    expect(detailsValid({})).toBe(false);
    expect(detailsValid({ follower, other: 1 })).toBe(false);
    expect(detailsValid({ follower: { id: 1 } })).toBe(false);
    expect(detailsValid({ purchases: [] })).toBe(false);
    expect(detailsValid({ purchases: [{ ...purchase, variant_ids: [] }] })).toBe(false);
  });
});

describe("compactDetails", () => {
  it("drops blank values and the blank keys of each purchase", () => {
    expect(
      compactDetails({
        follower: {},
        purchases: [{ ...purchase, license_uses: null, subscription_cancelled: false }],
        affiliates: [],
      }),
    ).toEqual({ purchases: [purchase] });
  });

  it("leaves details with a follower alone", () => {
    expect(compactDetails({ follower })).toEqual({ follower });
  });
});
