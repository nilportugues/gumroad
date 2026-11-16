import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taxonomyByPath: vi.fn(),
  taxonomiesForNav: vi.fn(),
}));

vi.mock("../../search/search-products.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../search/search-products.ts")>()),
  normalizeSearchParamValues: async (params: Record<string, unknown>) => ({ ...params }),
}));
vi.mock("./taxonomies.ts", () => ({ taxonomyByPath: mocks.taxonomyByPath, taxonomiesForNav: mocks.taxonomiesForNav }));
vi.mock("../../presenters/product.ts", () => ({
  cardForWeb: vi.fn(),
  linkFields: { externalId: (row: { id: bigint }) => `ext-${row.id}` },
}));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));

import type { LinkRow } from "../../presenters/product-reads.ts";

import { type DiscoverRequest, discoverProps, prepareSearch } from "./discover.ts";

const rows = (count: number, taxonomyIds: (bigint | null)[] = []): LinkRow[] =>
  Array.from(
    { length: count },
    (_, index) => ({ id: BigInt(index + 1), taxonomy_id: taxonomyIds[index] ?? null }) as unknown as LinkRow,
  );
const root = { path: "/discover", queryString: "" };

beforeEach(() => {
  mocks.taxonomyByPath.mockReset();
  mocks.taxonomiesForNav.mockReset();
  mocks.taxonomiesForNav.mockResolvedValue([]);
});

describe("prepareSearch with curated products", () => {
  it("sorts by the curated order and boosts the products after the strip", async () => {
    const prepared = await prepareSearch(root, null, rows(11));
    expect(prepared.params.sort).toBe("curated");
    expect(prepared.params.curated_product_ids).toEqual([9, 10, 11]);
    expect(prepared.searchParams).toMatchObject({ sort: "curated", curated_product_ids: [9, 10, 11], size: 36 });
  });

  it("boosts nothing when the strip shows the whole list, but still sorts by it", async () => {
    const prepared = await prepareSearch(root, null, rows(8));
    expect(prepared.params).toMatchObject({ sort: "curated", curated_product_ids: [] });
  });

  it("leaves the search offset alone, because the strip is curated", async () => {
    const prepared = await prepareSearch(root, null, rows(3));
    expect(prepared.params.from).toBeUndefined();
  });

  it("skips past the eight products of the strip when there are no curated products", async () => {
    const prepared = await prepareSearch(root, null, []);
    expect(prepared.params).toEqual({ from: 9 });
    expect(prepared.searchParams.sort).toBeUndefined();
  });

  it("keeps a sort the visitor asked for and boosts nothing", async () => {
    const prepared = await prepareSearch({ path: "/discover", queryString: "sort=newest" }, null, rows(11));
    expect(prepared.params).toEqual({ sort: "newest" });
  });

  it("replaces a sort that is only whitespace", async () => {
    const prepared = await prepareSearch({ path: "/discover", queryString: "sort=%20" }, null, rows(2));
    expect(prepared.params.sort).toBe("curated");
  });

  it("sorts a taxonomy page by the curated order too", async () => {
    mocks.taxonomyByPath.mockResolvedValue({ id: 5n, parent_id: null, slug: "3d" });
    const prepared = await prepareSearch({ path: "/3d", queryString: "" }, null, rows(2));
    expect(prepared.params).toMatchObject({ taxonomy: "3d", sort: "curated" });
    expect(prepared.searchParams).toMatchObject({
      taxonomy_id: 5n,
      include_taxonomy_descendants: true,
      sort: "curated",
    });
  });
});

describe("discoverProps with curated products", () => {
  const request = {} as DiscoverRequest;

  it("lists the external ids of every curated product and sorts the nav by their taxonomies", async () => {
    const prepared = await prepareSearch(root, null, rows(3, [4n, null, 9n]));
    mocks.taxonomiesForNav.mockResolvedValue([{ slug: "films" }]);
    const props = await discoverProps(prepared, {} as never, null, request, null);
    expect(props.curated_product_ids).toEqual(["ext-1", "ext-2", "ext-3"]);
    expect(mocks.taxonomiesForNav).toHaveBeenCalledWith([4n, 9n]);
    expect(props.taxonomies_for_nav).toEqual([{ slug: "films" }]);
  });

  it("lists nothing and leaves the nav alone without curated products", async () => {
    const prepared = await prepareSearch(root, null, []);
    const props = await discoverProps(prepared, {} as never, null, request, null);
    expect(props.curated_product_ids).toEqual([]);
    expect(mocks.taxonomiesForNav).toHaveBeenCalledWith([]);
  });
});
