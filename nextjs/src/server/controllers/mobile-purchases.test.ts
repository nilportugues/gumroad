import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileAction, MobileAuth, MobileInput } from "./mobile-api.ts";

const {
  actions,
  selectRows,
  process,
  creatorAppPurchasesJson,
  findLink,
  linkOptions,
  db,
  preloadProductUpdatesData,
  purchaseJsonDataForMobile,
  setLibraryFlag,
  loadLibraryPurchase,
  urlRedirectMobileData,
  mobilePreview,
} = vi.hoisted(() => ({
  actions: [] as MobileAction[],
  selectRows: vi.fn(),
  process: vi.fn(),
  creatorAppPurchasesJson: vi.fn(),
  findLink: vi.fn(),
  linkOptions: vi.fn(),
  db: {
    purchase: { findFirst: vi.fn() },
    link: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    urlRedirect: { findMany: vi.fn() },
  },
  preloadProductUpdatesData: vi.fn(),
  purchaseJsonDataForMobile: vi.fn(),
  setLibraryFlag: vi.fn(),
  loadLibraryPurchase: vi.fn(),
  urlRedirectMobileData: vi.fn(),
  mobilePreview: vi.fn(),
}));

vi.mock("./mobile-api.ts", async (original) => ({
  ...(await original<typeof import("./mobile-api.ts")>()),
  registerMobile: (...registered: MobileAction[]) => void actions.push(...registered),
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../presenters/product-reads.ts", () => ({ findLink }));
vi.mock("../presenters/product-props.ts", () => ({ linkOptions }));
vi.mock("../../lib/db.ts", () => ({ db }));
vi.mock("../models/purchase-library-writes.ts", () => ({ setLibraryFlag, loadLibraryPurchase }));
vi.mock("../models/purchase-product-updates.ts", () => ({ preloadProductUpdatesData }));
vi.mock("../page-props/signed-in/presenters.ts", () => ({
  avatarUrl: async () => "https://example.com/avatar.png",
  signedInPresenters: {},
}));
vi.mock("../page-props/buyer/users.ts", () => ({ profileUrl: () => "https://seller.example.com" }));
vi.mock("../presenters/mobile-preview.ts", () => ({ mobilePreview }));
vi.mock("../presenters/mobile-url-redirect.ts", () => ({ urlRedirectMobileData }));
vi.mock("../presenters/mobile-serializers.ts", () => ({ purchaseJsonDataForMobile }));
vi.mock("../presenters/mobile-serializer-reads.ts", () => ({
  creatorAppPurchasesJson,
  thumbnailUrlsByProduct: async () => new Map([[2n, "https://example.com/thumb.png"]]),
  amountRefundedCentsByPurchase: async () => new Map(),
  ratingByPurchase: async () => new Map(),
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
  mobilePreview.mockReset().mockResolvedValue({ preview: null, thumbnailOrCoverUrl: "https://example.com/thumb.png" });
  process.mockReset();
  creatorAppPurchasesJson.mockReset();
  findLink.mockReset();
  linkOptions.mockReset();
  db.purchase.findFirst.mockReset();
  db.link.findUnique.mockReset();
  db.user.findUnique.mockReset();
  preloadProductUpdatesData.mockReset();
  purchaseJsonDataForMobile.mockReset();
  setLibraryFlag.mockReset();
  loadLibraryPurchase.mockReset();
  urlRedirectMobileData.mockReset();
  db.urlRedirect.findMany.mockReset();
  db.urlRedirect.findMany.mockResolvedValue([]);
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
      ["GET", "/mobile/sales/:id/options"],
    ] as const) {
      expect(find(method, pattern).scopes).toEqual(["mobile_api"]);
    }
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

  it("answers the Pagy overflow 400 for a page beyond the first", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ page: "2" }), authFor());
    expect(status(result)).toBe(400);
    expect(body(result)).toEqual({ error: { message: "expected :page in 1..1; got 2" } });
  });

  it("answers the Pagy 400 for page 0 before the overflow check", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ page: "0" }), authFor());
    expect(body(result)).toEqual({ error: { message: "expected :page >= 1; got 0" } });
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
  const writes = [
    ["POST", "/mobile/purchases/:id/archive", "is_archived", true],
    ["POST", "/mobile/purchases/:id/unarchive", "is_archived", false],
    ["DELETE", "/mobile/purchases/:id", "is_deleted_by_buyer", true],
  ] as const;
  const row = {
    id: 12n,
    purchaser_id: 7n,
    seller_id: 9n,
    link_id: 2n,
    purchase_state: "successful",
    stripe_refunded: null,
    chargeback_date: null,
    subscription_id: null,
    preorder_id: null,
  };

  function stubPlain(rows: unknown[][] = [[], [], []]) {
    db.purchase.findFirst.mockResolvedValue(row);
    db.link.findUnique.mockResolvedValue({ id: 2n, user_id: 9n });
    db.user.findUnique.mockResolvedValue({ id: 9n, username: "seller", timezone: "Tokyo" });
    for (const result of rows) selectRows.mockResolvedValueOnce(result);
    preloadProductUpdatesData.mockResolvedValue(new Map([[12n, []]]));
    const record = { attributes: { ...row, flags: 1n } };
    loadLibraryPurchase.mockReturnValue(record);
    purchaseJsonDataForMobile.mockReturnValue({ name: "Product" });
    return record;
  }

  it.each(writes)("%s %s answers 404 for a purchase that is not the buyer's", async (method, pattern) => {
    db.purchase.findFirst.mockResolvedValue(null);
    const result = await find(method, pattern).run(input({ id: "12" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it.each(writes)(
    "%s %s sets the flag on the seller's time zone and renders the row it left",
    async (method, pattern, flag, value) => {
      const record = stubPlain();
      const result = await find(method, pattern).run(input({ id: "12" }), authFor());
      expect(body(result)).toEqual({ success: true, product: { name: "Product" } });
      expect(loadLibraryPurchase).toHaveBeenCalledWith(row, "Tokyo");
      expect(setLibraryFlag).toHaveBeenCalledWith(record, flag, value);
      expect(purchaseJsonDataForMobile.mock.calls[0]![0]).toMatchObject({ purchase: record.attributes });
    },
  );

  it.each([
    ["a membership purchase", { subscription_id: 3n }, []],
    ["a preorder purchase", { preorder_id: 3n }, []],
  ])("hands %s to Rails before writing", async (_name, extra, rows) => {
    stubPlain(rows);
    db.purchase.findFirst.mockResolvedValue({ ...row, ...extra });
    await expect(find("POST", "/mobile/purchases/:id/archive").run(input({ id: "12" }), authFor())).rejects.toThrow();
    expect(setLibraryFlag).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that does not decrypt, without querying", async () => {
    const result = await find("DELETE", "/mobile/purchases/:id").run(input({ id: "not-an-id" }), authFor());
    expect(status(result)).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });
});

describe("GET /mobile/purchases/purchase_attributes/:id", () => {
  const run = find("GET", "/mobile/purchases/purchase_attributes/:id").run;
  const purchase = (extra = {}) => ({
    id: 12n,
    purchaser_id: 7n,
    seller_id: 9n,
    link_id: 2n,
    purchase_state: "successful",
    stripe_refunded: null,
    chargeback_date: null,
    subscription_id: null,
    preorder_id: null,
    ...extra,
  });
  const link = { id: 2n, user_id: 9n };
  const creator = { id: 9n, username: "seller" };

  // The statements in order: refunds, product review, asset previews.
  function stub({ purchaseRow = purchase() as object | null, rows = [[], [], []] as unknown[][] } = {}) {
    db.purchase.findFirst.mockResolvedValue(purchaseRow);
    db.link.findUnique.mockResolvedValue(link);
    db.user.findUnique.mockResolvedValue(creator);
    for (const result of rows) selectRows.mockResolvedValueOnce(result);
    preloadProductUpdatesData.mockResolvedValue(new Map([[12n, []]]));
    purchaseJsonDataForMobile.mockReturnValue({ name: "Product", product_updates_data: [] });
  }

  it("serves a plain purchase with the product updates the preloader answers", async () => {
    stub();
    const result = await run(input({ id: "12" }), authFor());
    expect(body(result)).toEqual({ success: true, product: { name: "Product", product_updates_data: [] } });
    expect(db.purchase.findFirst).toHaveBeenCalledWith({ where: { id: 12n, purchaser_id: 7n } });
    expect(preloadProductUpdatesData).toHaveBeenCalledWith([purchase()]);
    expect(purchaseJsonDataForMobile.mock.calls[0]![0]).toMatchObject({
      productUpdatesData: [],
      purchaser: expect.objectContaining({ id: 7n }),
      link: { thumbnailOrCoverUrl: "https://example.com/thumb.png", preview: null },
    });
  });

  it("gives the serializer the preview fields and cover URL the product's covers yield", async () => {
    stub();
    const preview = {
      previewUrl: "https://example.com/c.png",
      previewOembedUrl: "",
      previewHeight: 0,
      previewWidth: 5,
    };
    mobilePreview.mockResolvedValue({ preview, thumbnailOrCoverUrl: "https://example.com/c.png" });
    await run(input({ id: "12" }), authFor());
    expect(mobilePreview).toHaveBeenCalledWith(2n, "https://example.com/thumb.png");
    expect(purchaseJsonDataForMobile.mock.calls[0]![0]).toMatchObject({
      link: { preview, thumbnailOrCoverUrl: "https://example.com/c.png" },
    });
  });

  it("adds the url redirect's keys and files when the purchase has one", async () => {
    stub();
    const redirect = { id: 5n, purchase_id: 12n };
    db.urlRedirect.findMany.mockResolvedValue([redirect]);
    urlRedirectMobileData.mockResolvedValue({ urlRedirectExternalId: "x", urlRedirectToken: "t", fileData: [] });
    await run(input({ id: "12" }), authFor());
    expect(urlRedirectMobileData.mock.calls[0]![0]).toMatchObject({ redirect, product: { id: 2n } });
    expect(purchaseJsonDataForMobile.mock.calls[0]![0]).toMatchObject({ urlRedirect: { urlRedirectToken: "t" } });
  });

  it("hands a purchase with several url redirects to Rails", async () => {
    stub();
    db.urlRedirect.findMany.mockResolvedValue([{ id: 5n }, { id: 6n }]);
    await expect(run(input({ id: "12" }), authFor())).rejects.toThrow();
  });

  it("refuses an unconfirmed account", async () => {
    expect(status(await run(input({ id: "12" }), authFor(false)))).toBe(403);
  });

  it("answers 404 for a purchase that is not the buyer's and for an id that does not decrypt", async () => {
    stub({ purchaseRow: null });
    const result = await run(input({ id: "12" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
    expect(status(await run(input({ id: "nope" }), authFor()))).toBe(404);
  });

  it.each([
    ["refunded", { stripe_refunded: true }],
    ["charged back", { chargeback_date: new Date() }],
    ["not successful", { purchase_state: "failed" }],
    ["a gift receiver's", { purchase_state: "gift_receiver_purchase_successful" }],
  ])("answers 404 for a %s purchase without a subscription", async (_name, extra) => {
    stub({ purchaseRow: purchase(extra) });
    expect(status(await run(input({ id: "12" }), authFor()))).toBe(404);
  });

  it.each([
    ["a membership purchase", { subscription_id: 3n }, []],
    ["a preorder purchase", { preorder_id: 3n }, []],
  ])("hands %s to Rails", async (_name, extra, rows) => {
    stub({ purchaseRow: purchase(extra), rows });
    await expect(run(input({ id: "12" }), authFor())).rejects.toThrow();
    expect(purchaseJsonDataForMobile).not.toHaveBeenCalled();
  });

  it("hands the purchase to Rails when the preloader cannot answer", async () => {
    stub();
    preloadProductUpdatesData.mockRejectedValue(new Error("Purchase.product_installments is not ported"));
    await expect(run(input({ id: "12" }), authFor())).rejects.toThrow(/not ported/u);
  });
});

describe("GET /mobile/sales", () => {
  const run = find("GET", "/mobile/sales").run;

  it("answers an empty page when the search matches nothing", async () => {
    process.mockResolvedValue({ total: 0, ids: [], response: {} });
    creatorAppPurchasesJson.mockResolvedValue([]);
    const result = await run(input({ page: "3" }), authFor());
    expect(body(result)).toEqual({
      success: true,
      purchases: [],
      pagination: { count: 0, page: 3, pages: 0, next: null },
    });
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ from: 40, size: 20, track_total_hits: true }));
  });

  it("serializes the hits in search order with the page count", async () => {
    process.mockResolvedValue({ total: 45, ids: ["9", "4"], response: {} });
    creatorAppPurchasesJson.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const result = await run(input({ page: "2" }), authFor());
    expect(creatorAppPurchasesJson).toHaveBeenCalledWith([9n, 4n]);
    expect(body(result)).toEqual({
      success: true,
      purchases: [{ id: "a" }, { id: "b" }],
      pagination: { count: 45, page: 2, pages: 3, next: 3 },
    });
  });

  it("has no next page on the last page", async () => {
    process.mockResolvedValue({ total: 20, ids: ["9"], response: {} });
    creatorAppPurchasesJson.mockResolvedValue([{ id: "a" }]);
    expect(body(await run(input(), authFor())).pagination).toEqual({ count: 20, page: 1, pages: 1, next: null });
  });

  it("answers an empty page beyond the last page", async () => {
    process.mockResolvedValue({ total: 1, ids: [], response: {} });
    creatorAppPurchasesJson.mockResolvedValue([]);
    expect(body(await run(input({ page: "2" }), authFor())).pagination).toEqual({
      count: 1,
      page: 2,
      pages: 1,
      next: null,
    });
  });

  it("hands back when a row is not a shape the serializer reproduces", async () => {
    process.mockResolvedValue({ total: 2, ids: ["1", "2"], response: {} });
    creatorAppPurchasesJson.mockRejectedValue(new Error("not ported"));
    await expect(run(input(), authFor())).rejects.toThrow("not ported");
  });
});

describe("GET /mobile/sales/:id", () => {
  const run = find("GET", "/mobile/sales/:id").run;

  it("answers 404 for a sale that is not the seller's", async () => {
    db.purchase.findFirst.mockResolvedValue(null);
    const result = await run(input({ id: "9" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
  });

  it("hands a sale with an affiliate to Rails before reading anything else", async () => {
    db.purchase.findFirst.mockResolvedValue({ id: 9n, flags: 0n, affiliate_id: 5n });
    await expect(run(input({ id: "9" }), authFor())).rejects.toThrow("a sale with an affiliate");
  });

  it("answers the blob_url collection route as blob_url, not as a sale id", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ id: "blob_url", key: "missing" }), authFor());
    expect(body(result)).toEqual({ success: false, message: "Could not find file" });
  });
});

describe("GET /mobile/sales/:id/options", () => {
  const run = find("GET", "/mobile/sales/:id/options").run;

  it("answers 404 for a sale that is not the seller's, without reading the product", async () => {
    selectRows.mockResolvedValue([]);
    const result = await run(input({ id: "9" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find purchase" });
    expect(findLink).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that does not decrypt, without querying", async () => {
    const result = await run(input({ id: "not-an-id" }), authFor());
    expect(status(result)).toBe(404);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale's product is gone", async () => {
    selectRows.mockResolvedValue([{ link_id: 5n }]);
    findLink.mockResolvedValue(null);
    const result = await run(input({ id: "9" }), authFor());
    expect(status(result)).toBe(404);
    expect(body(result)).toEqual({ success: false, message: "Could not find product" });
  });

  it("answers 404 for a sale with no product id", async () => {
    selectRows.mockResolvedValue([{ link_id: null }]);
    const result = await run(input({ id: "9" }), authFor());
    expect(body(result).message).toBe("Could not find product");
    expect(findLink).not.toHaveBeenCalled();
  });

  it("answers the product's options", async () => {
    const link = { id: 5n };
    selectRows.mockResolvedValue([{ link_id: 5n }]);
    findLink.mockResolvedValue(link);
    linkOptions.mockResolvedValue([{ id: "o1", name: "Basic" }]);
    const result = await run(input({ id: "9" }), authFor());
    expect(status(result)).toBe(200);
    expect(body(result)).toEqual({ success: true, options: [{ id: "o1", name: "Basic" }] });
    expect(findLink).toHaveBeenCalledWith(5n);
    expect(linkOptions).toHaveBeenCalledWith(link);
  });
});
