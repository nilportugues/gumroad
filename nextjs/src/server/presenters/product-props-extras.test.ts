import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ responses: [] as unknown[][], queries: [] as string[] }));

vi.mock("../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models/sql.ts")>()),
  selectRows: (query: { sql: string }) => {
    mocks.queries.push(query.sql);
    return Promise.resolve(mocks.responses.shift() ?? []);
  },
}));

vi.mock("../../lib/obfuscate-ids.ts", () => ({ encrypt: (id: bigint) => `ext-${id}` }));

import { assertNoBoughtPurchase, coverProps, wishlistProps } from "./product-props-extras.ts";

const row = { id: 7n } as never;
const GIFT_RECEIVER = 1n << 5n;
const GIFT_SENDER = 1n << 6n;
const ADDITIONAL_CONTRIBUTION = 1n << 0n;
const purchase = (overrides: Record<string, unknown> = {}) => ({
  purchase_state: "successful",
  stripe_refunded: null,
  chargeback_date: null,
  flags: 0n,
  ...overrides,
});

describe("assertNoBoughtPurchase", () => {
  beforeEach(() => {
    mocks.responses = [];
    mocks.queries = [];
  });

  it("reads nothing for a visitor with neither an account nor a browser guid", async () => {
    await assertNoBoughtPurchase(row, { userId: null, browserGuid: null }, false);

    expect(mocks.queries).toEqual([]);
  });

  it("hands back a signed-in visitor's successful purchase", async () => {
    mocks.responses = [[purchase()]];

    await expect(assertNoBoughtPurchase(row, { userId: 3n, browserGuid: null }, false)).rejects.toThrow(
      "Purchase#purchase_info",
    );
  });

  it.each([
    ["a fully refunded purchase", { stripe_refunded: true }],
    ["a charged back purchase", { chargeback_date: new Date() }],
    ["an additional contribution", { flags: ADDITIONAL_CONTRIBUTION }],
    ["a gift sender's purchase", { flags: GIFT_SENDER }],
    ["a failed purchase", { purchase_state: "failed" }],
    [
      "a preorder authorization on a product that is not in preorder",
      { purchase_state: "preorder_authorization_successful" },
    ],
  ])("renders no purchase for %s", async (_name, overrides) => {
    mocks.responses = [[purchase(overrides)]];

    await assertNoBoughtPurchase(row, { userId: 3n, browserGuid: null }, false);
  });

  it("hands back a preorder authorization on a product in preorder", async () => {
    mocks.responses = [[purchase({ purchase_state: "preorder_authorization_successful" })]];

    await expect(assertNoBoughtPurchase(row, { userId: 3n, browserGuid: null }, true)).rejects.toThrow(
      "Purchase#purchase_info",
    );
  });

  it("looks at the browser guid only when the visitor has no purchase of the product at all", async () => {
    mocks.responses = [[purchase({ stripe_refunded: true })], [purchase()]];

    await assertNoBoughtPurchase(row, { userId: 3n, browserGuid: "guid" }, false);

    expect(mocks.queries).toHaveLength(1);
  });

  it("hands back a purchase made with the browser guid", async () => {
    mocks.responses = [[], [purchase()]];

    await expect(assertNoBoughtPurchase(row, { userId: 3n, browserGuid: "guid" }, false)).rejects.toThrow(
      "Purchase#purchase_info",
    );
  });

  it("ignores a gift receiver's purchase made with the browser guid", async () => {
    mocks.responses = [[purchase({ flags: GIFT_RECEIVER })]];

    await assertNoBoughtPurchase(row, { userId: null, browserGuid: "guid" }, false);
  });
});

describe("coverProps", () => {
  beforeEach(() => {
    mocks.responses = [];
  });

  it("is empty for a product without covers", async () => {
    expect(await coverProps(row)).toEqual({ covers: [], main_cover_id: null });
  });

  it("serializes an Unsplash cover as its URL alone", async () => {
    mocks.responses = [[{ id: 1n, guid: "abc", oembed: null, unsplash_url: "https://images.example.com/a.jpg" }], []];

    const { covers, main_cover_id } = await coverProps(row);

    expect(main_cover_id).toBe("abc");
    expect(covers).toEqual([
      {
        url: "https://images.example.com/a.jpg",
        original_url: "https://images.example.com/a.jpg",
        thumbnail: null,
        id: "abc",
        type: "unsplash",
        filetype: null,
        width: null,
        height: null,
        native_width: null,
        native_height: null,
      },
    ]);
  });

  it("hands back an oEmbed cover", async () => {
    mocks.responses = [[{ id: 1n, guid: "abc", oembed: "---\n", unsplash_url: null }], []];

    await expect(coverProps(row)).rejects.toThrow("AssetPreview#as_json");
  });

  it("hands back a cover with an upload", async () => {
    mocks.responses = [
      [{ id: 1n, guid: "abc", oembed: null, unsplash_url: "https://images.example.com/a.jpg" }],
      [{ 1: 1 }],
    ];

    await expect(coverProps(row)).rejects.toThrow("AssetPreview#as_json");
  });
});

describe("wishlistProps", () => {
  beforeEach(() => {
    mocks.responses = [];
  });

  it("is empty for a seller without wishlists", async () => {
    expect(await wishlistProps(row, 3n)).toEqual([]);
  });

  it("lists each wishlist with what it holds of the product", async () => {
    mocks.responses = [
      [
        { id: 1n, name: "Holding" },
        { id: 2n, name: "Empty" },
      ],
      [{ wishlist_id: 1n, variant_id: null, recurrence: "monthly", rent: 0, quantity: 1 }],
    ];

    expect(await wishlistProps(row, 3n)).toEqual([
      {
        id: "ext-1",
        name: "Holding",
        selections_in_wishlist: [{ variant_id: null, recurrence: "monthly", rent: false, quantity: 1 }],
      },
      { id: "ext-2", name: "Empty", selections_in_wishlist: [] },
    ]);
  });
});
