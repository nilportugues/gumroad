import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wishlists: [] as unknown[],
  items: new Map<number, { id: bigint; product_id: bigint }[]>(),
  owner: { id: 1n, username: "seller", external_id: "ext", name: "Seller", verified: false } as unknown,
}));

vi.mock("../../../lib/db.ts", () => ({
  db: {
    wishlist: { findMany: async () => mocks.wishlists },
    wishlistProduct: {
      findMany: async ({ where, orderBy, take }: { where: { wishlist_id: bigint }; orderBy: { id: "desc" }; take: number }) => {
        expect(orderBy).toEqual({ id: "desc" });
        return [...(mocks.items.get(Number(where.wishlist_id)) ?? [])].sort((a, b) => Number(b.id - a.id)).slice(0, take);
      },
      count: async ({ where }: { where: { wishlist_id: bigint } }) => (mocks.items.get(Number(where.wishlist_id)) ?? []).length,
    },
  },
}));
vi.mock("../../presenters/product-reads.ts", () => ({
  findUserById: async () => mocks.owner,
  findLink: async (id: bigint) => ({ id, native_type: "digital" }),
  customDomainByHost: async () => null,
}));
vi.mock("../../presenters/product.ts", () => ({
  subdomainWithProtocol: (user: { username: string | null }) => (user.username ? `https://${user.username}.example.com` : null),
  authorBylineProps: async () => ({ id: "byline" }),
}));
vi.mock("../../presenters/product-page.ts", () => ({ sellerCustomDomainUrl: () => null }));
vi.mock("../../presenters/product-props.ts", () => ({ productProps: async () => ({}) }));
vi.mock("../buyer/products.ts", () => ({ thumbnailOrCoverUrl: async (id: bigint) => `thumb-${id}` }));
vi.mock("../buyer/wishlists.ts", () => ({ urlSlug: (wishlist: { name: string }) => `${wishlist.name.toLowerCase()}-1` }));
vi.mock("../../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: bigint | number) => `enc-${id}` }));

import { wishlistCardProps, wishlistsSectionProps } from "./featured-and-wishlist-sections.ts";

const BASE = { id: "section", header: null, type: "SellerProfileWishlistsSection" };
const wishlist = (id: number, name: string) => ({ id: BigInt(id), user_id: 1n, name, description: null, follower_count: 2 });
const products = (wishlistId: number, count: number) => mocks.items.set(wishlistId, Array.from({ length: count }, (_, n) => ({ id: BigInt(n + 1), product_id: BigInt(100 + n) })));

describe("wishlistsSectionProps", () => {
  beforeEach(() => {
    mocks.wishlists = [];
    mocks.items.clear();
    mocks.owner = { id: 1n, username: "seller", external_id: "ext", name: "Seller", verified: false };
  });

  it("lists the wishlists in the order the seller arranged them", async () => {
    mocks.wishlists = [wishlist(1, "A"), wishlist(2, "B")];
    const props = await wishlistsSectionProps(BASE, { shown_wishlists: [2, 9, 1] });
    expect(props.wishlists.map((card) => card.name)).toEqual(["B", "A"]);
    expect(props.shown_wishlists).toEqual(["enc-2", "enc-9", "enc-1"]);
  });

  it("shows the last four products as thumbnails, oldest first", async () => {
    mocks.wishlists = [wishlist(1, "A")];
    products(1, 6);
    const [card] = (await wishlistsSectionProps(BASE, { shown_wishlists: [1] })).wishlists;
    expect(card!.thumbnails.map((thumbnail) => thumbnail.url)).toEqual(["thumb-102", "thumb-103", "thumb-104", "thumb-105"]);
    expect(card!.product_count).toBe(6);
  });

  it("shows only the newest product's thumbnail below four products", async () => {
    mocks.wishlists = [wishlist(1, "A")];
    products(1, 3);
    const [card] = (await wishlistsSectionProps(BASE, { shown_wishlists: [1] })).wishlists;
    expect(card!.thumbnails).toEqual([{ url: "thumb-102", native_type: "digital" }]);
  });

  it("builds the profile-layout URL and the visitor's follow state", async () => {
    mocks.wishlists = [wishlist(1, "A")];
    const [card] = (await wishlistsSectionProps(BASE, { shown_wishlists: [1] })).wishlists;
    expect(card).toMatchObject({ url: "https://seller.example.com/wishlists/a-1?layout=profile", thumbnails: [], following: false, can_follow: true, follower_count: 2 });
  });

  it("follows the current seller: following as given and no follow button on their own wishlist", async () => {
    const own = await wishlistCardProps(wishlist(1, "A") as never, { layout: "discover", recommendedBy: "discover_wishlist", currentSellerId: 1n });
    expect(own).toMatchObject({ following: false, can_follow: false, url: "https://seller.example.com/wishlists/a-1?layout=discover&recommended_by=discover_wishlist" });
    const other = await wishlistCardProps(wishlist(1, "A") as never, { layout: "discover", currentSellerId: 9n, following: true });
    expect(other).toMatchObject({ following: true, can_follow: true });
  });

  it("hands a wishlist whose owner has no subdomain back to Rails", async () => {
    mocks.wishlists = [wishlist(1, "A")];
    mocks.owner = { id: 1n, username: null };
    await expect(wishlistsSectionProps(BASE, { shown_wishlists: [1] })).rejects.toThrow("no subdomain");
  });
});
