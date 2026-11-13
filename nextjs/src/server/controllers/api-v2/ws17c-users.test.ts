import type { Link, Purchase, User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "ws17c-users-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const mocks = vi.hoisted(() => ({
  db: { purchase: { findMany: vi.fn() }, assetPreview: { count: vi.fn() } },
}));
vi.mock("../../../lib/db.ts", () => ({ db: mocks.db }));

const { iftttSaleQuery, iftttSaleTrigger, purchaseAsJsonForIfttt } = await import("./ws17c-users.ts");
const { encrypt } = await import("../../../lib/obfuscate-ids.ts");
const { NotPortedError } = await import("../../page-props/not-ported.ts");

const seller = { id: 7n, username: "seller" } as unknown as User;
const link = (over: Partial<Link> = {}) =>
  ({
    id: 3n,
    name: "Sketch pack",
    unique_permalink: "abc",
    custom_permalink: null,
    description: "<p>Hello <strong>world</strong></p>",
    ...over,
  }) as unknown as Link;
const purchase = (over: Partial<Purchase> = {}) =>
  ({
    id: 11n,
    link_id: 3n,
    seller_id: 7n,
    email: "buyer@example.com",
    created_at: new Date("2024-03-01T12:00:00Z"),
    price_cents: 1250,
    displayed_price_cents: 1250,
    displayed_price_currency_type: "usd",
    price_id: null,
    subscription_id: null,
    flags: 0n,
    ...over,
  }) as unknown as Purchase;
const sale = (over: Partial<Purchase> = {}, purchaser: { email: string } | null = null) => ({
  ...purchase(over),
  link: link(),
  purchaser,
});
const call = (params: Record<string, unknown>) => ({ owner: seller, token: {}, params }) as never;
type Trigger = { success: boolean; data: { meta: { id: string }; PurchaseEmail: string }[] };
const body = (rendered: unknown) => JSON.parse(String((rendered as { body?: unknown }).body)) as Trigger;

beforeEach(() => {
  mocks.db.purchase.findMany.mockReset();
  mocks.db.assetPreview.count.mockReset().mockResolvedValue(0);
});

describe("iftttSaleQuery", () => {
  it("lists the newest 50 sales without a range", () => {
    expect(iftttSaleQuery({})).toEqual({ where: {}, direction: "desc", limit: 50 });
  });

  it("reads after as a lower bound in ascending order, ahead of before", () => {
    expect(iftttSaleQuery({ after: "1709337600", before: "1709500000", limit: "5" })).toEqual({
      where: { gte: new Date("2024-03-02T00:00:00Z") },
      direction: "asc",
      limit: 5,
    });
  });

  it("reads before as an upper bound in descending order", () => {
    expect(iftttSaleQuery({ before: 1709337600 })).toEqual({
      where: { lte: new Date("2024-03-02T00:00:00Z") },
      direction: "desc",
      limit: 50,
    });
  });

  it("ignores a blank after and falls through to before", () => {
    expect(iftttSaleQuery({ after: "", before: "0" }).where).toEqual({ lte: new Date(0) });
  });

  it("keeps a limit of zero", () => {
    expect(iftttSaleQuery({ limit: "0" }).limit).toBe(0);
  });

  it.each([["010"], [""], ["abc"], ["-1"], ["1.5"], [2.5], [true], [["5"]], [{ a: 1 }], ["99999999"]])(
    "hands back the limit %j",
    (limit) => {
      expect(() => iftttSaleQuery({ limit })).toThrow(NotPortedError);
    },
  );

  it.each([["12abc"], ["1.5"], [[1]], [{ a: 1 }], [true]])("hands back the time %j", (after) => {
    expect(() => iftttSaleQuery({ after })).toThrow(NotPortedError);
  });
});

describe("purchaseAsJsonForIfttt", () => {
  it("renders Purchase#as_json_for_ifttt without an image", () => {
    expect(purchaseAsJsonForIfttt(purchase(), link(), seller, null)).toEqual({
      meta: { id: encrypt(11n), timestamp: 1709294400 },
      Price: "$12.50",
      ProductName: "Sketch pack",
      PurchaseEmail: "buyer@example.com",
      ProductDescription: "Hello world",
      ProductURL: expect.stringMatching(/^https?:\/\/seller\..+\/l\/abc$/u),
    });
  });

  it("prefers the purchaser's account email", () => {
    expect(purchaseAsJsonForIfttt(purchase(), link(), seller, "account@example.com").PurchaseEmail).toBe(
      "account@example.com",
    );
  });

  it("prices a purchase in another currency at its stored rate", () => {
    const euro = purchase({ price_cents: 1250, displayed_price_currency_type: "eur", rate_converted_to_usd: "1.11" });
    expect(purchaseAsJsonForIfttt(euro, link(), seller, null).Price).toBe("€13.88");
  });

  it("hands back a purchase in another currency with no stored rate", () => {
    expect(() =>
      purchaseAsJsonForIfttt(purchase({ displayed_price_currency_type: "eur" }), link(), seller, null),
    ).toThrow(NotPortedError);
  });

  it("hands back a subscription charge", () => {
    expect(() => purchaseAsJsonForIfttt(purchase({ subscription_id: 4n }), link(), seller, null)).toThrow(
      NotPortedError,
    );
  });
});

describe("iftttSaleTrigger", () => {
  it("returns the seller's successful sales as data, newest first", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([
      sale({ id: 12n }, { email: "account@example.com" }),
      sale({ id: 11n }),
    ]);
    const result = body(await iftttSaleTrigger(call({ limit: "5" })));
    expect(result.success).toBe(true);
    expect(result.data.map((row) => row.meta.id)).toEqual([encrypt(12n), encrypt(11n)]);
    expect(result.data[0]!.PurchaseEmail).toBe("account@example.com");
    expect(mocks.db.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seller_id: 7n, purchase_state: { in: ["preorder_authorization_successful", "successful"] } },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: 5,
      }),
    );
  });

  it("filters from after, oldest first", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([]);
    await iftttSaleTrigger(call({ after: "1709337600" }));
    expect(mocks.db.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ created_at: { gte: new Date("2024-03-02T00:00:00Z") } }),
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("returns an empty list for a seller without sales", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([]);
    expect(body(await iftttSaleTrigger(call({})))).toEqual({ success: true, data: [] });
    expect(mocks.db.assetPreview.count).not.toHaveBeenCalled();
  });

  it("hands back sales of a product with a cover", async () => {
    mocks.db.purchase.findMany.mockResolvedValueOnce([sale()]);
    mocks.db.assetPreview.count.mockResolvedValueOnce(1);
    await expect(iftttSaleTrigger(call({}))).rejects.toBeInstanceOf(NotPortedError);
  });
});
