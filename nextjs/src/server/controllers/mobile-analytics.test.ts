import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, search, purchasesJson } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  search: vi.fn(),
  purchasesJson: vi.fn(),
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
