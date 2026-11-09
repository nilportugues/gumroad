// The pure readings of CustomerPresenter / CustomersController that the recorded fixtures reach only in part.
import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { displayReferrer, pageOffset, refundableCents, refundIsEffective, rubyToI, totalPages } from "./customers.ts";

const purchase = (overrides: Record<string, unknown>) => ({ flags: 0n, recommended_by: null, referrer: null, ...overrides });

describe("String#to_i", () => {
  it("reads the leading integer and treats anything else as zero", () => {
    expect([rubyToI("3"), rubyToI(" 12abc"), rubyToI("-4"), rubyToI("1_000"), rubyToI("abc"), rubyToI(undefined)]).toEqual([3, 12, -4, 1000, 0, 0]);
  });
});

describe("pagination", () => {
  it("clamps the offset to the last legal Elasticsearch window", () => {
    expect([pageOffset(undefined), pageOffset("1"), pageOffset("2"), pageOffset("500"), pageOffset("9999"), pageOffset("-3")]).toEqual([0, 20, 40, 9980, 9980, 0]);
  });

  it("caps the page count at the result window", () => {
    expect([totalPages(0), totalPages(1), totalPages(20), totalPages(21), totalPages(1_000_000)]).toEqual([0, 1, 1, 2, 500]);
  });
});

describe("Purchase#display_referrer", () => {
  it("names the Gumroad surfaces a sale came through", () => {
    expect(displayReferrer(purchase({ recommended_by: "library" }), "seller")).toBe("Gumroad Library");
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "receipt" }), "seller")).toBe("Gumroad Receipt");
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "wishlist" }), "seller")).toBe("Gumroad Wishlist");
    expect(displayReferrer(purchase({ flags: 1n << 8n, recommended_by: "search" }), "seller")).toBe("Gumroad Discover");
  });

  it("names a referring site, the seller's own profile and direct visits", () => {
    expect(displayReferrer(purchase({ referrer: "direct" }), "seller")).toBe("Direct");
    expect(displayReferrer(purchase({ referrer: "https://t.co/abc" }), "seller")).toBe("Twitter");
    expect(displayReferrer(purchase({ referrer: "https://news.example.com/story" }), "seller")).toBe("news.example.com");
    expect(displayReferrer(purchase({ referrer: "https://seller.gumroad.com/l/x" }), "seller")).toBe("Profile");
    expect(displayReferrer(purchase({ referrer: "  " }), "seller")).toBeNull();
  });
});

describe("Refund#effective?", () => {
  it("counts every refund except a failed or canceled one whose balance was reversed", () => {
    expect(refundIsEffective({ status: "succeeded", json_data: null })).toBe(true);
    expect(refundIsEffective({ status: null, json_data: null })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: null })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: "{}" })).toBe(true);
    expect(refundIsEffective({ status: "failed", json_data: '{"balance_reversed_on_failure":false}' })).toBe(true);
    expect(refundIsEffective({ status: "canceled", json_data: '{"balance_reversed_on_failure":true}' })).toBe(false);
    expect(refundIsEffective({ status: "succeeded", json_data: '{"balance_reversed_on_failure":true}' })).toBe(true);
  });

  it("hands back a failed refund whose json_data it cannot read as Ruby does", () => {
    expect(() => refundIsEffective({ status: "failed", json_data: "not json" })).toThrow(HandBackToRails);
    expect(() => refundIsEffective({ status: "failed", json_data: '{"balance_reversed_on_failure":1}' })).toThrow(HandBackToRails);
  });
});

describe("Purchase#amount_refundable_cents_in_currency", () => {
  it("subtracts the effective refunds from the price of a sale charged through a known processor", async () => {
    expect(await refundableCents({ charge_processor_id: "stripe", price_cents: 500 }, 100, "usd")).toBe(400);
    expect(await refundableCents({ charge_processor_id: "paypal", price_cents: 500 }, 0, "usd")).toBe(500);
    expect(await refundableCents({ charge_processor_id: "paypal", price_cents: 500 }, 500, "usd")).toBe(0);
    expect(await refundableCents({ charge_processor_id: null, price_cents: 500 }, 0, "usd")).toBe(0);
  });

  it("converts the refundable dollars at the rate stored on the sale", async () => {
    expect(await refundableCents({ charge_processor_id: "stripe", price_cents: 1250, rate_converted_to_usd: "0.8" }, 250, "eur")).toBe(800);
    expect(await refundableCents({ charge_processor_id: "stripe", price_cents: 1000, rate_converted_to_usd: "110" }, 0, "jpy")).toBe(1100);
  });
});
