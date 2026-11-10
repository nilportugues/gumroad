import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searches: [] as Record<string, unknown>[],
  cards: [] as Record<string, unknown>[],
}));

vi.mock("../../search/search-products.ts", async () => {
  const actual = await vi.importActual<typeof import("../../search/search-products.ts")>("../../search/search-products.ts");
  return {
    ...actual,
    validFilterTokens: async () => new Set<string>(),
    searchProductsWithFacets: async (params: Record<string, unknown>) => {
      mocks.searches.push(params);
      return { total: 1, tags_data: [], filetypes_data: [], taxonomy_attributes_data: [], product_ids: ["5"] };
    },
  };
});
vi.mock("../../presenters/product-reads.ts", () => ({ findLink: async (id: bigint) => ({ id, flags: 0n }) }));
vi.mock("../../presenters/product.ts", () => ({
  remainingForSaleCount: async () => 1,
  cardForWeb: async (id: bigint, options: Record<string, unknown>) => {
    mocks.cards.push(options);
    return { id: String(id) };
  },
}));
vi.mock("../../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: bigint | number) => `enc-${id}` }));

import { HandBackToRails } from "../../controllers/application-controller.ts";
import type { PresenterRequest } from "../../presenters/product.ts";
import { productsSectionProps, visitorSearchParams } from "./product-sections.ts";

const REQUEST = {} as PresenterRequest;
const SELLER = { id: 1n } as never;
const HEADER = { id: "default-products", header: null };

describe("visitorSearchParams", () => {
  it("is null when the query carries no visitor search param", async () => {
    expect(await visitorSearchParams("")).toBeNull();
    expect(await visitorSearchParams("utm_source=x&page=2")).toBeNull();
  });

  it("normalizes tags and filetypes into lists and coerces from and size", async () => {
    expect(await visitorSearchParams("tags=Hello-World,%20Foo&filetypes=PDF,%20Mp3&from=3&size=99999&query=a+b")).toEqual({
      tags: ["hello world", "foo"],
      filetypes: ["pdf", "mp3"],
      from: 3,
      size: 10_000,
      query: "a b",
    });
  });

  it("reads the last of a repeated param and nil for a param without a value", async () => {
    expect(await visitorSearchParams("query=a&query=b&sort")).toEqual({ query: "b", sort: null });
  });

  it("hands a nested shape back to Rails", async () => {
    await expect(visitorSearchParams("tags[]=a")).rejects.toBeInstanceOf(HandBackToRails);
    await expect(visitorSearchParams("min_price%5Bx%5D=1")).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("productsSectionProps with visitor params", () => {
  beforeEach(() => {
    mocks.searches = [];
    mocks.cards = [];
  });

  it("merges the visitor's filters into the section search and keeps the section's own scope", async () => {
    await productsSectionProps(SELLER, null, HEADER, REQUEST, { query: "x", sort: "price_asc", recommended_by: "discover" });
    expect(mocks.searches[0]).toMatchObject({ query: "x", sort: "price_asc", is_alive_on_profile: true, user_id: 1 });
    expect(mocks.cards[0]).toMatchObject({ recommendedBy: "discover" });
  });

  it("falls back to the section's sort when the visitor's sort is nil and keeps an empty one", async () => {
    await productsSectionProps(SELLER, null, HEADER, REQUEST, { sort: null });
    await productsSectionProps(SELLER, null, HEADER, REQUEST, { sort: "" });
    expect(mocks.searches.map((search) => search.sort)).toEqual(["page_layout", ""]);
  });

  it("searches as before without visitor params", async () => {
    await productsSectionProps(SELLER, null, HEADER, REQUEST);
    expect(mocks.searches[0]).not.toHaveProperty("query");
    expect(mocks.cards[0]).toMatchObject({ recommendedBy: null });
  });
});
