import { beforeEach, describe, expect, it, vi } from "vitest";

const { purchases, links, users, selectRows, hasAttachment } = vi.hoisted(() => ({
  purchases: vi.fn(),
  links: vi.fn(),
  users: vi.fn(),
  selectRows: vi.fn(),
  hasAttachment: vi.fn(),
}));

vi.mock("../../lib/db.ts", () => ({
  db: { purchase: { findMany: purchases }, link: { findMany: links }, user: { findMany: users } },
}));
vi.mock("../models/sql.ts", async (original) => ({
  ...(await original<typeof import("../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../page-props/buyer/products.ts", () => ({ hasAttachment }));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  encrypt: (id: bigint) => `enc${id}`,
  encryptNumeric: (id: number) => id,
}));

const { creatorAppPurchasesJson } = await import("./mobile-serializer-reads.ts");

const NOW = new Date("2026-11-02T15:00:00.000Z");
const seller = { id: 7n, timezone: "UTC" };
const link = { id: 3n, name: "Product", flags: 0n };
const row = (id: bigint) => ({
  id,
  seller_id: 7n,
  purchaser_id: null,
  link_id: 3n,
  email: "a@example.com",
  created_at: NOW,
  price_cents: 500,
  displayed_price_cents: 500,
  displayed_price_currency_type: "usd",
  fee_cents: 0,
  flags: 0n,
  price_id: null,
  subscription_id: null,
  stripe_partially_refunded: false,
  chargeback_date: null,
});

beforeEach(() => {
  for (const mock of [purchases, links, users, selectRows, hasAttachment]) mock.mockReset();
  links.mockResolvedValue([link]);
  users.mockResolvedValue([seller]);
});

describe("creatorAppPurchasesJson", () => {
  it("reads nothing for no ids", async () => {
    expect(await creatorAppPurchasesJson([], NOW)).toEqual([]);
    expect(purchases).not.toHaveBeenCalled();
  });

  it("keeps the order of the ids and drops an id with no row", async () => {
    purchases.mockResolvedValue([row(1n), row(2n)]);
    selectRows.mockResolvedValue([]);
    const json = await creatorAppPurchasesJson([2n, 9n, 1n], NOW);
    expect(json.map((entry) => entry.id)).toEqual(["enc2", "enc1"]);
  });

  it("flags the product variants and the unsplash thumbnail", async () => {
    purchases.mockResolvedValue([row(1n)]);
    selectRows.mockImplementation(async (query: { sql: string }) =>
      query.sql.includes("thumbnails")
        ? [{ id: 1n, product_id: 3n, unsplash_url: "https://images.example.com/t.jpg", deleted_at: null }]
        : [{ link_id: 3n }],
    );
    const [json] = await creatorAppPurchasesJson([1n], NOW);
    expect(json).toMatchObject({
      product_has_variants: true,
      product_thumbnail_url: "https://images.example.com/t.jpg",
    });
  });

  it("reads a deleted first thumbnail as none", async () => {
    purchases.mockResolvedValue([row(1n)]);
    selectRows.mockImplementation(async (query: { sql: string }) =>
      query.sql.includes("thumbnails")
        ? [
            { id: 1n, product_id: 3n, unsplash_url: "https://images.example.com/old.jpg", deleted_at: NOW },
            { id: 2n, product_id: 3n, unsplash_url: "https://images.example.com/new.jpg", deleted_at: null },
          ]
        : [],
    );
    const [json] = await creatorAppPurchasesJson([1n], NOW);
    expect(json!.product_thumbnail_url).toBeNull();
  });

  it("refuses an uploaded thumbnail", async () => {
    purchases.mockResolvedValue([row(1n)]);
    hasAttachment.mockResolvedValue(true);
    selectRows.mockImplementation(async (query: { sql: string }) =>
      query.sql.includes("thumbnails") ? [{ id: 1n, product_id: 3n, unsplash_url: null, deleted_at: null }] : [],
    );
    await expect(creatorAppPurchasesJson([1n], NOW)).rejects.toThrow(/not ported/u);
  });

  it("refuses a purchase whose product row is missing", async () => {
    purchases.mockResolvedValue([row(1n)]);
    links.mockResolvedValue([]);
    selectRows.mockResolvedValue([]);
    await expect(creatorAppPurchasesJson([1n], NOW)).rejects.toThrow(/not ported/u);
  });
});
