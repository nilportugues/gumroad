import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, search, purchasesJson, countProducts, productIds, dataForDates } = vi.hoisted(() => ({
  dataForDates: vi.fn(),
  actions: [] as MobileAction[],
  search: vi.fn(),
  purchasesJson: vi.fn(),
  countProducts: vi.fn(),
  productIds: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../search/purchase-search.ts", () => ({
  PurchaseSearchService: class {
    constructor(readonly options: unknown) {}
    process() {
      return search(this.options);
    }
  },
}));
vi.mock("../presenters/mobile-serializer-reads.ts", () => ({ creatorAppPurchasesJson: purchasesJson }));

vi.mock("../page-props/analytics/caching-proxy.ts", () => ({
  CreatorAnalyticsCachingProxy: class {
    dataForDates(...args: unknown[]) {
      return dataForDates(...args);
    }
  },
}));
vi.mock("../page-props/analytics/seller-analytics.ts", () => ({
  countProductsForCreatorAnalytics: countProducts,
  productIdsForCreatorAnalytics: productIds,
}));

await import("./mobile-analytics.ts");

const run = actions.find((action) => action.pattern === "/mobile/analytics/data_by_date")!.run;
const auth = { owner: { id: 7n, timezone: "UTC" } } as unknown as MobileAuth;
const input = (params: Record<string, unknown>) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const aggregations = {
  price_cents_total: { value: 1500 },
  amount_refunded_cents_total: { value: 500 },
  chargedback_agg: { price_cents_total: { value: 0 }, amount_refunded_cents_total: { value: 0 } },
};

describe("GET /mobile/analytics/data_by_date", () => {
  beforeEach(() => {
    search.mockReset();
    purchasesJson.mockReset();
    search.mockResolvedValue({ total: 2, ids: ["12", "11"], response: { aggregations } });
    purchasesJson.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  });

  it("answers revenue, the sales count and the purchases in that order", async () => {
    const result = body(await run(input({ range: "all" }), auth));

    expect(Object.keys(result)).toEqual(["revenue", "formatted_revenue", "sales_count", "purchases"]);
    expect(result).toMatchObject({
      revenue: 1000,
      formatted_revenue: "$10",
      sales_count: 2,
      purchases: [{ id: "a" }, { id: "b" }],
    });
    expect(purchasesJson).toHaveBeenCalledWith([12n, 11n]);
  });

  it("asks for the newest 300 sales with the total, and adds the query only when present", async () => {
    await run(input({ range: "all", query: "buyer" }), auth);
    await run(input({ range: "all", query: "" }), auth);

    const [withQuery, blank] = search.mock.calls.map(([options]) => options);
    expect(withQuery).toMatchObject({
      size: 300,
      track_total_hits: true,
      sort: [{ created_at: { order: "desc" } }, { id: { order: "desc" } }],
      seller_query: "buyer",
    });
    expect(blank).not.toHaveProperty("seller_query");
  });

  it("limits the sales to the current period unless the range is all", async () => {
    await run(input({ range: "all" }), auth);
    await run(input({ range: "week" }), auth);

    const [all, week] = search.mock.calls.map(([options]) => options);
    expect(all).not.toHaveProperty("created_on_or_after");
    expect(week.created_on_or_after).toBeInstanceOf(Date);
  });

  it.each([[{}], [{ range: "decade" }], [{ range: ["day"] }], [{ range: "day", query: ["a"] }]])(
    "hands %j to Rails, which raises or casts it itself",
    async (params) => {
      await expect(run(input(params), auth)).rejects.toBeInstanceOf(HandBackToRails);
      expect(search).not.toHaveBeenCalled();
    },
  );
});

describe("GET /mobile/analytics/by_state", () => {
  const byState = actions.find((action) => action.pattern === "/mobile/analytics/by_state")!.run;

  beforeEach(() => dataForDates.mockReset().mockResolvedValue({ by_state: {} }));

  it.each([
    [{ start_date: "2026-03-01", end_date: "2026-03-02" }],
    [{ start_date: "1 March 2026", end_date: "2 March 2026" }],
  ])("reads the dates of %j as the same two days", async (params) => {
    await byState(input(params), auth);

    expect(dataForDates).toHaveBeenCalledExactlyOnceWith("2026-03-01", "2026-03-02", "state");
  });

  it("reads a day and month written out in full for every month", async () => {
    await byState(input({ start_date: "31 December 2025", end_date: "9 January 2026" }), auth);

    expect(dataForDates).toHaveBeenCalledExactlyOnceWith("2025-12-31", "2026-01-09", "state");
  });

  it.each([["31 February 2026"], ["1 Marchh 2026"], ["March 1 2026"], ["1 march 2026"], ["1 March 26"]])(
    "hands the date %j to Rails, which reads it itself",
    async (date) => {
      await expect(byState(input({ start_date: date, end_date: "2026-03-02" }), auth)).rejects.toBeInstanceOf(
        HandBackToRails,
      );
      expect(dataForDates).not.toHaveBeenCalled();
    },
  );
});

describe("GET /mobile/analytics/products", () => {
  const products = actions.find((action) => action.pattern === "/mobile/analytics/products")!.run;

  beforeEach(() => {
    countProducts.mockReset().mockResolvedValue(45);
    productIds.mockReset().mockResolvedValue([9n, 8n]);
  });

  it("answers the integer ids with Pagy's metadata", async () => {
    const result = body(await products(input({ page: "2" }), auth));

    expect(result).toEqual({
      products: [{ id: 9 }, { id: 8 }],
      meta: { pagination: { count: 45, items: 20, page: 2, pages: 3, prev: 1, next: 3, last: 3 } },
    });
    expect(productIds).toHaveBeenCalledWith(7n, 20, 20);
  });

  it("reads the page size from items", async () => {
    await products(input({ items: "5" }), auth);

    expect(productIds).toHaveBeenCalledWith(7n, 5, 0);
  });

  it("answers a single empty page when the seller has no products", async () => {
    countProducts.mockResolvedValue(0);
    productIds.mockResolvedValue([]);

    expect(body(await products(input({}), auth)).meta.pagination).toEqual({
      count: 0,
      items: 20,
      page: 1,
      pages: 1,
      prev: null,
      next: null,
      last: 1,
    });
  });

  it("renders the Pagy overflow as a 400", async () => {
    const result = (await products(input({ page: "4" }), auth)) as { status: number; body: string };

    expect(result.status).toBe(400);
    expect(body(result)).toEqual({ error: { message: "expected :page in 1..3; got 4" } });
    expect(productIds).not.toHaveBeenCalled();
  });

  it.each([[{ page: "0" }], [{ items: "0" }], [{ items: "" }], [{ page: "x" }], [{ items: ["1"] }]])(
    "hands %j to Rails, which raises or casts it itself",
    async (params) => {
      await expect(products(input(params), auth)).rejects.toBeInstanceOf(HandBackToRails);
    },
  );
});
