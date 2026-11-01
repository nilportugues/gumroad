// The pure readings of CustomerPresenter / CustomersController that the recorded fixtures reach only in part.
import { describe, expect, it } from "vitest";

import { displayReferrer, pageOffset, rubyToI, totalPages } from "./customers.ts";

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
