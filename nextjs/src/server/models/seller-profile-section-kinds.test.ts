import { describe, expect, it } from "vitest";

import { SECTION_KINDS } from "./seller-profile-section-kinds.ts";
import { NotPortedError } from "./user.ts";

const valid = (type: string, hash: Record<string, unknown>) => SECTION_KINDS.get(type)!.valid(hash as never);

describe("profile section schemas", () => {
  it("accepts a products section holding all four keys", () => {
    const hash = {
      default_product_sort: "newest",
      shown_products: [1, 2],
      show_filters: false,
      add_new_products: true,
    };
    expect(valid("SellerProfileProductsSection", hash)).toBe(true);
  });

  it("refuses a products section with a string where a boolean belongs", () => {
    const hash = { default_product_sort: "newest", shown_products: [], show_filters: "yes", add_new_products: true };
    expect(valid("SellerProfileProductsSection", hash)).toBe(false);
  });

  it("refuses a products section missing a required key", () => {
    expect(valid("SellerProfileProductsSection", { shown_products: [] })).toBe(false);
  });

  it("accepts an empty featured product section and refuses a null featured product", () => {
    expect(valid("SellerProfileFeaturedProductSection", {})).toBe(true);
    expect(valid("SellerProfileFeaturedProductSection", { featured_product_id: null })).toBe(false);
  });

  it("requires a posts section to list unique integers and nothing else", () => {
    expect(valid("SellerProfilePostsSection", { shown_posts: [] })).toBe(true);
    expect(valid("SellerProfilePostsSection", { shown_posts: [1, 1] })).toBe(false);
    expect(valid("SellerProfilePostsSection", { shown_posts: [null] })).toBe(false);
    expect(valid("SellerProfilePostsSection", { shown_posts: [1], extra: true })).toBe(false);
    expect(valid("SellerProfilePostsSection", {})).toBe(false);
  });

  it("requires a subscribe section to hold a string button label", () => {
    expect(valid("SellerProfileSubscribeSection", { button_label: "" })).toBe(true);
    expect(valid("SellerProfileSubscribeSection", { button_label: 1 })).toBe(false);
  });

  it("requires a wishlists section to list unique integers", () => {
    expect(valid("SellerProfileWishlistsSection", { shown_wishlists: [3] })).toBe(true);
    expect(valid("SellerProfileWishlistsSection", { shown_wishlists: [3, 3] })).toBe(false);
  });

  it("requires a rich text section to hold a text object, and hands back one near its size limit", () => {
    expect(valid("SellerProfileRichTextSection", { text: {} })).toBe(true);
    expect(valid("SellerProfileRichTextSection", { text: [] })).toBe(false);
    expect(() => valid("SellerProfileRichTextSection", { text: { content: "x".repeat(400_001) } })).toThrow(
      NotPortedError,
    );
  });
});
