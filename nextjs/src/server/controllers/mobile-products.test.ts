import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, findMany } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../lib/db.ts", () => ({ db: { link: { findMany } } }));
vi.mock("../page-props/seller-products/listing.ts", () => ({
  assertPriceSupported: vi.fn(),
  assertThumbnailsSupported: vi.fn(),
  loadRowData: vi.fn(async () => ({})),
  priceFormattedVerbose: () => "$1",
  productFlag: (flags: number) => flags === 1,
  thumbnailJson: (row: { thumb?: string }) => (row.thumb ? { url: row.thumb, guid: null } : null),
}));
vi.mock("../policies/link.ts", () => ({
  collaboratingProductIds: vi.fn(async () => new Set()),
  linkPolicy: { edit: () => true, destroy: () => true },
}));

await import("./mobile-products.ts");

const run = actions.find((action) => action.pattern === "/mobile/products")!.run;
const auth = { owner: { id: 7n } } as unknown as MobileAuth;
const input = (params: Record<string, unknown> = {}) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const row = (id: bigint, extra = {}) => ({
  id,
  name: `Product ${id}`,
  unique_permalink: `p${id}`,
  draft: false,
  purchase_disabled_at: null,
  flags: 0,
  ...extra,
});

// Pass 1 of selectRows is the COUNT, pass 2 the page of ids.
const stub = (count: number, ids: bigint[], rows = ids.map((id) => row(id))) => {
  selectRows.mockReset();
  selectRows.mockResolvedValueOnce([{ count: BigInt(count) }]).mockResolvedValueOnce(ids.map((id) => ({ id })));
  findMany.mockResolvedValue(rows);
};

beforeEach(() => findMany.mockReset());

describe("GET /mobile/products", () => {
  it("registers behind the mobile_api scope and leaves destroy to Rails", () => {
    expect(actions.map((action) => [action.method, action.pattern, action.scopes])).toEqual([
      ["GET", "/mobile/products", ["mobile_api"]],
    ]);
  });

  // spec/controllers/api/mobile/products_controller_spec.rb "returns the seller's visible products newest first"
  it("lists the page in the order of the id query with the dashboard row fields", async () => {
    stub(2, [2n, 1n]);
    const json = body(await run(input(), auth));
    expect(json.success).toBe(true);
    expect(json.products.map((product: { id: string }) => product.id)).toEqual(["p2", "p1"]);
    expect(json.products[0]).toEqual({
      id: "p2",
      name: "Product 2",
      permalink: "p2",
      price_formatted: "$1",
      status: "published",
      thumbnail_url: null,
      can_edit: true,
      can_destroy: true,
    });
    expect(json.pagination).toEqual({ count: 2, page: 1, pages: 1, next: null });
  });

  it("reports an unpublished and a preorder product", async () => {
    stub(2, [1n, 2n], [row(1n, { draft: true }), row(2n, { flags: 1 })]);
    const json = body(await run(input(), auth));
    expect(json.products.map((product: { status: string }) => product.status)).toEqual(["unpublished", "preorder"]);
  });

  it("returns the thumbnail url of a product with a thumbnail", async () => {
    stub(1, [1n], [row(1n, { thumb: "https://example.com/t.png" })]);
    expect(body(await run(input(), auth)).products[0].thumbnail_url).toBe("https://example.com/t.png");
  });

  // "paginates products": 1 of 2 on the first page
  it("points next at the following page while there are more", async () => {
    stub(41, [1n]);
    expect(body(await run(input({ page: "2" }), auth)).pagination).toEqual({ count: 41, page: 2, pages: 3, next: 3 });
  });

  it("answers an empty first page for a seller without products", async () => {
    stub(0, []);
    expect(body(await run(input(), auth))).toEqual({
      success: true,
      products: [],
      pagination: { count: 0, page: 1, pages: 1, next: null },
    });
  });

  it("treats page 0 as the first page", async () => {
    stub(0, []);
    expect(body(await run(input({ page: "0" }), auth)).pagination.page).toBe(1);
  });

  it("escapes LIKE wildcards in the name filter", async () => {
    stub(0, []);
    await run(input({ query: "50%_off" }), auth);
    const sql = selectRows.mock.calls[0]![0] as { values: unknown[] };
    expect(sql.values).toContain("%50\\%\\_off%");
  });

  it("answers Pagy's 400 for a page past the last one, without running the after actions", async () => {
    stub(1, [1n]);
    const result = await run(input({ page: "2" }), auth);
    expect(result).toMatchObject({ status: 400, rescued: true });
    expect(body(result)).toEqual({ error: { message: "expected :page in 1..1; got 2" } });
    expect(selectRows).toHaveBeenCalledTimes(1);
  });

  it("counts pages from the filtered total in the overflow message", async () => {
    stub(41, [1n]);
    expect(body(await run(input({ page: "4" }), auth)).error.message).toBe("expected :page in 1..3; got 4");
  });

  it("hands back a non-digit page and a non-string query", async () => {
    stub(1, [1n]);
    await expect(run(input({ page: "abc" }), auth)).rejects.toThrow(/page/u);
    await expect(run(input({ query: ["a"] }), auth)).rejects.toThrow(/query/u);
  });
});
