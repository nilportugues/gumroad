import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  doc: {} as Record<string, string>,
  search: vi.fn(),
  findLink: vi.fn(),
  card: vi.fn(),
}));

vi.mock("../../infra/flipper.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/flipper.ts")>()),
  readFeatureDoc: async () => mocks.doc,
  isFeatureEnabled: async (_name: string, actor: unknown) => {
    const { evaluateFeature, parseGateValues } = await import("../../infra/flipper.ts");
    return evaluateFeature("discover_recently_viewed", parseGateValues(mocks.doc), actor as string);
  },
}));
vi.mock("../../search/search-products.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../search/search-products.ts")>()),
  searchProductsWithFacets: mocks.search,
}));
vi.mock("../../presenters/product-reads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../presenters/product-reads.ts")>()),
  findLink: mocks.findLink,
}));
vi.mock("../../presenters/product.ts", () => ({ cardForWeb: mocks.card }));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));

import { deferredProps, deferredPropsPortable, requestedDeferredProps, type DiscoverRequest, type PreparedSearch } from "./discover.ts";
import { isLazyProp } from "../lazy-props.ts";

const request: DiscoverRequest = {
  path: "/discover",
  queryString: "",
  method: "GET",
  headers: new Headers(),
  host: "gumroad.com",
  hostWithPort: "gumroad.com",
  protocol: "https://",
  remoteIp: "127.0.0.1",
  cookies: new Map(),
  guid: null,
};
const prepared = (params: Record<string, unknown>, taxonomy: { id: bigint } | null = null) => ({ params, taxonomy, searchParams: {} }) as unknown as PreparedSearch;
const resolve = (props: Record<string, unknown>, name: string) => (props[name] as { resolve: () => unknown }).resolve();

beforeEach(() => {
  mocks.doc = {};
  mocks.search.mockReset();
  mocks.findLink.mockReset();
  mocks.card.mockReset();
});

describe("deferred Discover props", () => {
  it("reads the props a deferred-only request asks for", () => {
    expect(requestedDeferredProps(new Headers({ "x-inertia-partial-data": "recommended_products,recently_viewed" }))).toEqual(["recommended_products", "recently_viewed"]);
  });

  it("answers recommended_products for an offer code page and a taxonomy page", async () => {
    expect(await deferredPropsPortable(["recommended_products"], prepared({ offer_code: "X" }), null, null)).toBe(true);
    expect(await deferredPropsPortable(["recommended_products"], prepared({}, { id: 5n }), null, null)).toBe(true);
  });

  it("hands back the root page's random recommendations and the wishlists", async () => {
    expect(await deferredPropsPortable(["recommended_products"], prepared({}), null, null)).toBe(false);
    expect(await deferredPropsPortable(["recommended_wishlists"], prepared({ offer_code: "X" }), null, null)).toBe(false);
    expect(await deferredPropsPortable(["recommended_products", "recommended_wishlists"], prepared({}, { id: 5n }), null, null)).toBe(false);
  });

  it("answers recently_viewed with nil for an offer code page, a visitor with no identity and a dark flag", async () => {
    expect(await deferredPropsPortable(["recently_viewed"], prepared({ offer_code: "X" }), null, "guid")).toBe(true);
    expect(await deferredPropsPortable(["recently_viewed"], prepared({}), null, null)).toBe(true);
    expect(await deferredPropsPortable(["recently_viewed"], prepared({}), null, "guid")).toBe(true);
    expect(await resolve(deferredProps(prepared({}), { ...request, guid: "guid" }, null), "recently_viewed")).toBeNull();
  });

  it("hands back recently_viewed once the flag is on or ramping", async () => {
    mocks.doc = { boolean: "true" };
    expect(await deferredPropsPortable(["recently_viewed"], prepared({}), null, "guid")).toBe(false);
    mocks.doc = { percentage_of_actors: "50" };
    expect(await deferredPropsPortable(["recently_viewed"], prepared({}), null, "guid")).toBe(false);
  });

  it("returns no recommended products on an offer code page without searching", async () => {
    const props = deferredProps(prepared({ offer_code: "X" }), request, null);
    expect(isLazyProp(props.recommended_products)).toBe(true);
    expect(await resolve(props, "recommended_products")).toEqual([]);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("searches the taxonomy's descendants for eight products and builds the featured cards", async () => {
    mocks.search.mockResolvedValue({ product_ids: [3, 4, 9] });
    mocks.findLink.mockImplementation(async (id: bigint) => (id === 4n ? null : { id }));
    mocks.card.mockImplementation(async (id: bigint) => ({ id }));
    const cards = await resolve(deferredProps(prepared({}, { id: 5n }), request, null), "recommended_products");
    expect(mocks.search).toHaveBeenCalledWith({ size: 8, taxonomy_id: 5n, include_taxonomy_descendants: true });
    expect(cards).toEqual([{ id: 3n }, { id: 9n }]);
    expect(mocks.card.mock.calls[0]![1]).toMatchObject({ recommendedBy: "discover", target: "discover", descriptionMaxLength: 300 });
  });
});
