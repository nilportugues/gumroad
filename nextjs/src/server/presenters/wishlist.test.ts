import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ responses: [] as unknown[][] }));

vi.mock("../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models/sql.ts")>()),
  selectRows: () => Promise.resolve(mocks.responses.shift() ?? []),
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  encrypt: (id: bigint) => `ext-${id}`,
  encryptNumeric: (id: number) => id * 2,
}));
vi.mock("./product.ts", () => ({
  cardForWeb: vi.fn(async (id: bigint, options: Record<string, unknown>) => ({ id, ...options })),
  longUrl: (row: { unique_permalink: string }) => `https://seller.example.com/l/${row.unique_permalink}`,
  subdomainWithProtocol: (user: { username: string | null }) =>
    user.username ? `https://${user.username}.example.com` : null,
}));
vi.mock("./product-reads.ts", () => ({ alivePrices: vi.fn(), findLink: vi.fn(), findUserById: vi.fn() }));
vi.mock("./product-props.ts", () => ({ variantToOption: vi.fn() }));
vi.mock("../page-props/signed-in/presenters.ts", () => ({
  avatarUrl: async () => "/avatar.png",
  displayName: (user: { name: string | null; username: string }) => user.name ?? user.username,
}));

import { MetaTagBuilder } from "../page-props/meta-tags.ts";

import { findLink, findUserById } from "./product-reads.ts";
import { publicItems, setWishlistPageMeta, urlSlug, type WishlistRow } from "./wishlist.ts";

const wishlist: WishlistRow = {
  id: 5n,
  user_id: 9n,
  name: "Reading list!",
  description: null,
  recommendable: 1,
};
const owner = { id: 9n, name: "Ada", username: "ada", external_id: "ext" } as never;
const request = {
  host: "ada.example.com",
  hostWithPort: "ada.example.com",
  protocol: "https://",
  remoteIp: "",
  params: {},
  cookies: new Map(),
};
const row = (id: bigint, overrides: Record<string, unknown> = {}) => ({
  id,
  product_id: id,
  variant_id: null,
  recurrence: null,
  quantity: 1,
  rent: 0,
  created_at: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

beforeEach(() => {
  mocks.responses = [];
  vi.mocked(findLink).mockReset();
  vi.mocked(findUserById).mockReset();
});

describe("urlSlug", () => {
  it("parameterizes the name and appends the numeric external id", () => {
    expect(urlSlug(wishlist)).toBe("reading-list-10");
  });
});

describe("publicItems", () => {
  it("answers the empty page past the last one with the last page as prev", async () => {
    // count, then the global affiliate
    mocks.responses = [[{ count: 21n }], []];

    const page = await publicItems(wishlist, { request, currentSellerId: null, page: 9 });

    expect(page.items).toEqual([]);
    expect(page.pagination).toEqual({ count: 21, items: 0, page: 9, pages: 2, prev: 2, next: null, last: 2 });
  });

  it("counts an empty wishlist as one page", async () => {
    mocks.responses = [[{ count: 0n }], [], []];

    const page = await publicItems(wishlist, { request, currentSellerId: null, page: 1 });

    expect(page.pagination).toEqual({ count: 0, items: 20, page: 1, pages: 1, prev: null, next: null, last: 1 });
  });

  it("withholds the gift from the wishlist's owner and from a product whose seller disabled gifting", async () => {
    const product = {
      id: 1n,
      user_id: 3n,
      flags: 0n,
      purchase_disabled_at: null,
      banned_at: null,
      deleted_at: null,
      draft: false,
    };
    vi.mocked(findLink).mockResolvedValue(product as never);
    vi.mocked(findUserById).mockResolvedValue({ id: 3n, flags: 0n } as never);
    mocks.responses = [[{ count: 1n }], [row(1n)], []];

    const asVisitor = await publicItems(wishlist, { request, currentSellerId: 4n, page: 1 });
    expect(asVisitor.items[0]).toMatchObject({ giftable: true, purchasable: true });

    mocks.responses = [[{ count: 1n }], [row(1n)], []];
    const asOwner = await publicItems(wishlist, { request, currentSellerId: 9n, page: 1 });
    expect(asOwner.items[0]).toMatchObject({ giftable: false });
  });

  it("defaults the recommender to wishlist and keeps one that was passed", async () => {
    const product = {
      id: 1n,
      user_id: 3n,
      flags: 0n,
      purchase_disabled_at: null,
      banned_at: null,
      deleted_at: null,
      draft: false,
    };
    vi.mocked(findLink).mockResolvedValue(product as never);
    vi.mocked(findUserById).mockResolvedValue({ id: 3n, flags: 0n } as never);

    mocks.responses = [[{ count: 1n }], [row(1n)], []];
    expect((await publicItems(wishlist, { request, currentSellerId: null, page: 1 })).items[0]?.product).toMatchObject({
      recommendedBy: "wishlist",
    });

    mocks.responses = [[{ count: 1n }], [row(1n)], []];
    const items = await publicItems(wishlist, { request, currentSellerId: null, page: 1, recommendedBy: "search" });
    expect(items.items[0]?.product).toMatchObject({ recommendedBy: "search" });
  });
});

describe("setWishlistPageMeta", () => {
  const tags = (meta: MetaTagBuilder) => Object.fromEntries(meta.toJSON().map((tag) => [tag.headKey, tag]));

  it("describes a wishlist without a description by its distinct product count", async () => {
    // distinct count for the description, then for the index gate
    mocks.responses = [[{ count: 1n }], [{ count: 1n }]];
    const meta = new MetaTagBuilder();

    await setWishlistPageMeta(meta, wishlist, owner);

    expect(tags(meta)["meta-name-description"]).toMatchObject({
      content: "Reading list! — a wishlist of 1 digital product curated by Ada on Gumroad.",
    });
    expect(tags(meta)["meta-name-robots"]).toMatchObject({ content: "noindex" });
    expect(tags(meta)).not.toHaveProperty("structured-data");
  });

  it("keeps a wishlist that is not recommendable out of the index however many products it has", async () => {
    mocks.responses = [[{ count: 5n }], [{ count: 5n }]];
    const meta = new MetaTagBuilder();

    await setWishlistPageMeta(meta, { ...wishlist, recommendable: 0 }, owner);

    expect(tags(meta)["meta-name-robots"]).toMatchObject({ content: "noindex" });
  });
});
