import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const { actions, selectRows, process } = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  process: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../search/purchase-search.ts", () => ({ PurchaseSearchService: { process } }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  decrypt: (value: string) => (/^\d+$/u.test(value) ? Number(value) : null),
}));

await import("./mobile-purchases.ts");

const find = (method: string, pattern: string) =>
  actions.find((action) => action.method === method && action.pattern === pattern)!;
const user = (confirmed: boolean) => ({ id: 7n, external_id: "ext7", confirmed_at: confirmed ? new Date() : null });
const authFor = (confirmed = true): MobileAuth =>
  ({ owner: user(confirmed), accountHolder: user(confirmed), impersonated: null }) as unknown as MobileAuth;
const input = (params: Record<string, unknown> = {}) => ({ params }) as unknown as MobileInput;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);
const status = (result: unknown) => (result as { status: number }).status;

beforeEach(() => {
  selectRows.mockReset();
  process.mockReset();
});

describe("registration", () => {
  it("registers every purchases and sales read and the purchase writes behind the mobile_api scope", () => {
    for (const [method, pattern] of [
      ["GET", "/mobile/purchases/index"],
      ["GET", "/mobile/purchases/search"],
      ["GET", "/mobile/purchases/purchase_attributes/:id"],
      ["POST", "/mobile/purchases/:id/archive"],
      ["POST", "/mobile/purchases/:id/unarchive"],
      ["DELETE", "/mobile/purchases/:id"],
      ["GET", "/mobile/sales"],
      ["GET", "/mobile/sales/:id"],
    ] as const) {
      expect(find(method, pattern).scopes).toEqual(["mobile_api"]);
    }
  });

  it("leaves sales#update to Rails", () => {
    expect(actions.some((action) => action.method !== "GET" && action.pattern.startsWith("/mobile/sales"))).toBe(false);
  });
});

describe("GET /mobile/purchases/index", () => {
  const run = find("GET", "/mobile/purchases/index").run;

  it("answers 403 for an unconfirmed library owner", async () => {
    const result = await run(input(), authFor(false));
    expect(status(result)).toBe(403);
    expect(body(result)).toEqual({
      success: false,
      message: "Please confirm your email address before you can see your purchases.",
    });
  });

  it("answers an empty first page with the Pagy metadata when the buyer has no purchases", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ per_page: "500" }), authFor());
    expect(body(result)).toEqual({
      success: true,
      products: [],
      user_id: "ext7",
      meta: { pagination: { count: 0, items: 100, page: 1, pages: 1, prev: null, next: null, last: 1 } },
    });
  });

  it("hands back when the buyer has purchases", async () => {
    selectRows.mockResolvedValue([{ "1": 1 }]);
    await expect(run(input(), authFor())).rejects.toThrow();
  });

  it("hands back a page beyond the first", async () => {
    selectRows.mockResolvedValue([]);
    await expect(run(input({ page: "2" }), authFor())).rejects.toThrow();
  });
});

describe("GET /mobile/purchases/search", () => {
  const run = find("GET", "/mobile/purchases/search").run;

  it("answers an empty result sized by items when the buyer has no purchases", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ q: "x", items: "3" }), authFor());
    expect(body(result)).toEqual({
      success: true,
      user_id: "ext7",
      purchases: [],
      sellers: [],
      meta: { pagination: { count: 0, items: 3, page: 1, pages: 1, prev: null, next: null, last: 1 } },
    });
  });

  it("hands back a filter that is not a string", async () => {
    await expect(run(input({ q: { a: 1 } }), authFor())).rejects.toThrow();
  });
});

describe("purchase member actions", () => {
  it.each([
    ["GET", "/mobile/purchases/purchase_attributes/:id"],
    ["POST", "/mobile/purchases/:id/archive"],
    ["POST", "/mobile/purchases/:id/unarchive"],
    ["DELETE", "/mobile/purchases/:id"],
  ])("%s %s answers 404 for a purchase that is not the buyer's", async (method, pattern) => {
    selectRows.mockResolvedValue([]);
    const result = await find(method, pattern).run(input({ id: "12" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
  });

  it("hands a purchase that exists to Rails", async () => {
    selectRows.mockResolvedValue([{ "1": 1 }]);
    await expect(find("POST", "/mobile/purchases/:id/archive").run(input({ id: "12" }), authFor())).rejects.toThrow();
  });

  it("answers 404 for an id that does not decrypt, without querying", async () => {
    const result = await find("DELETE", "/mobile/purchases/:id").run(input({ id: "not-an-id" }), authFor());
    expect(status(result)).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });
});

describe("GET /mobile/sales", () => {
  const run = find("GET", "/mobile/sales").run;

  it("answers an empty page when the search matches nothing", async () => {
    process.mockResolvedValue({ total: 0, ids: [], response: {} });
    const result = await run(input({ page: "3" }), authFor());
    expect(body(result)).toEqual({
      success: true,
      purchases: [],
      pagination: { count: 0, page: 3, pages: 0, next: null },
    });
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ from: 40, size: 20, track_total_hits: true }));
  });

  it("hands back when the search has hits", async () => {
    process.mockResolvedValue({ total: 2, ids: ["1", "2"], response: {} });
    await expect(run(input(), authFor())).rejects.toThrow();
  });
});

describe("GET /mobile/sales/:id", () => {
  const run = find("GET", "/mobile/sales/:id").run;

  it("answers 404 for a sale that is not the seller's", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ id: "9" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
  });

  it("hands a sale that exists to Rails", async () => {
    selectRows.mockResolvedValue([{ "1": 1 }]);
    await expect(run(input({ id: "9" }), authFor())).rejects.toThrow();
  });

  it("hands the blob_url collection route to Rails", async () => {
    await expect(run(input({ id: "blob_url" }), authFor())).rejects.toThrow();
    expect(selectRows).not.toHaveBeenCalled();
  });
});
