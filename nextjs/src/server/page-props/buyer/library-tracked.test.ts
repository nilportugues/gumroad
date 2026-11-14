import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "library-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { link, subscription } = vi.hoisted(() => ({
  link: { findUniqueOrThrow: vi.fn() },
  subscription: { findUnique: vi.fn() },
}));
vi.mock("../../../lib/db.ts", () => ({ db: { link, subscription } }));
vi.mock("../../presenters/product.ts", async (original) => ({
  ...(await original<typeof import("../../presenters/product.ts")>()),
  buyerCurrencyDisplayProps: async () => ({ display_mode: "default" }),
}));

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { LinkFlags } from "../../models/link.ts";
import { setSqlClient } from "../../models/sql.ts";

import { purchaseAnalyticsProps, receiptPurchases } from "./library.ts";

const EXTERNAL_ID = encrypt(5);
const RECURRING = LinkFlags.set(0n, "is_recurring_billing", true);
const BLOCKS_ACCESS = LinkFlags.set(RECURRING, "block_access_after_membership_cancellation", true);

type Answers = { users?: Record<string, unknown>[]; purchases?: Record<string, unknown>[]; analytics?: unknown[]; links?: Record<string, unknown>[] };

function answering({ users = [], purchases = [], analytics = [], links = [] }: Answers) {
  const statements: string[] = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      statements.push(query.sql);
      if (query.sql.includes("FROM `third_party_analytics`")) return analytics;
      if (query.sql.includes("FROM `purchase_presentments`")) return [];
      if (query.sql.includes("`links`.*")) return links;
      if (query.sql.includes("`users`.*")) return users;
      if (query.sql.includes("`purchases`.*")) return purchases;
      throw new Error(`unexpected statement: ${query.sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
  return statements;
}

const purchaseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 5n,
  email: "buyer@example.com",
  seller_id: 3n,
  price_cents: 0,
  shipping_cents: 0,
  link_id: 9n,
  subscription_id: null,
  flags: 0n,
  displayed_price_currency_type: "usd",
  displayed_price_cents: 1500,
  quantity: 1,
  tax_cents: 0,
  ...overrides,
});
const productRow = (overrides: Record<string, unknown> = {}) => ({ id: 9n, user_id: 3n, name: "Course", unique_permalink: "abc", price_currency_type: "usd", flags: 0n, ...overrides });
const sellerRow = (overrides: Record<string, unknown> = {}) => ({ id: 3n, external_id: "seller-ext", flags: 0n, google_analytics_id: null, facebook_pixel_id: null, json_data: null, ...overrides });

beforeEach(() => {
  link.findUniqueOrThrow.mockReset();
  subscription.findUnique.mockReset();
});

describe("purchaseAnalyticsProps", () => {
  it("is empty for an id that is not one of the buyer's purchases", async () => {
    answering({ purchases: [] });
    expect(await purchaseAnalyticsProps(1n, [EXTERNAL_ID])).toEqual({});
  });

  it("makes no query for a missing, blank or undecodable id", async () => {
    const statements = answering({});
    await purchaseAnalyticsProps(1n, []);
    await purchaseAnalyticsProps(1n, [""]);
    await purchaseAnalyticsProps(1n, ["not an id!"]);
    expect(statements).toEqual([]);
  });

  it("is empty when the seller has no pixel ids", async () => {
    answering({ purchases: [purchaseRow()], links: [productRow()], users: [sellerRow()] });
    expect(await purchaseAnalyticsProps(1n, [EXTERNAL_ID])).toEqual({});
  });

  it.each([
    ["Google Analytics", { google_analytics_id: "UA-1" }],
    ["Facebook", { facebook_pixel_id: "123" }],
    ["an empty but present Google Analytics id", { google_analytics_id: "" }],
  ])("builds the event when the seller has %s", async (_, columns) => {
    answering({ purchases: [purchaseRow()], links: [productRow()], users: [sellerRow(columns)] });
    expect(Object.keys(await purchaseAnalyticsProps(1n, [EXTERNAL_ID]))).toEqual([EXTERNAL_ID]);
  });

  it("builds an event for each tracked purchase, in id order, and ignores ids that are not the buyer's", async () => {
    const statements = answering({
      purchases: [purchaseRow(), purchaseRow({ id: 6n })],
      links: [productRow()],
      users: [sellerRow({ google_analytics_id: "UA-1" })],
    });
    const props = await purchaseAnalyticsProps(1n, [encrypt(6), "not an id!", EXTERNAL_ID, EXTERNAL_ID]);
    expect(Object.keys(props)).toEqual([EXTERNAL_ID, encrypt(6)]);
    expect(statements.find((sql) => sql.includes("`purchases`.*"))).toContain("IN (?,?) ORDER BY `purchases`.`id` ASC");
  });

  it("reads only the first 50 tracked ids", async () => {
    const statements = answering({});
    await purchaseAnalyticsProps(
      1n,
      Array.from({ length: 60 }, (_, index) => encrypt(index + 1)),
    );
    expect(statements[0]!.match(/\?/gu)).toHaveLength(51);
  });

  it("hands back a purchase displayed in another currency", async () => {
    answering({ purchases: [purchaseRow({ displayed_price_currency_type: "gbp" })], links: [productRow()], users: [sellerRow({ google_analytics_id: "UA-1" })] });
    await expect(purchaseAnalyticsProps(1n, [EXTERNAL_ID])).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a product priced in another currency", async () => {
    answering({ purchases: [purchaseRow()], links: [productRow({ price_currency_type: "gbp" })], users: [sellerRow({ google_analytics_id: "UA-1" })] });
    await expect(purchaseAnalyticsProps(1n, [EXTERNAL_ID])).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("receiptPurchases", () => {
  it("is empty without a tracked purchase", async () => {
    const statements = answering({});
    expect(await receiptPurchases(1n, [])).toEqual([]);
    expect(statements).toEqual([]);
  });

  it("is empty for a purchase that is not visible in the library", async () => {
    answering({ purchases: [] });
    expect(await receiptPurchases(1n, [EXTERNAL_ID])).toEqual([]);
  });

  it("lists the visible purchase with its email, permalink and receipt analytics flag", async () => {
    answering({ purchases: [purchaseRow()], analytics: [{ 1: 1 }], users: [sellerRow({ name: "Ana" })] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect(await receiptPurchases(1n, [EXTERNAL_ID])).toEqual([
      { id: EXTERNAL_ID, email: "buyer@example.com", free: true, seller_id: "seller-ext", seller_name: "Ana", permalink: "abc", has_third_party_analytics: true },
    ]);
  });

  it("marks a purchase that paid anything as not free and names a seller without a name by username", async () => {
    answering({ purchases: [purchaseRow({ price_cents: 500 })], users: [sellerRow({ username: "ana" })] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect((await receiptPurchases(1n, [EXTERNAL_ID]))[0]).toMatchObject({ free: false, seller_name: "ana" });
  });

  it("treats a purchase with only shipping paid as not free", async () => {
    answering({ purchases: [purchaseRow({ shipping_cents: 100 })], users: [sellerRow()] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect((await receiptPurchases(1n, [EXTERNAL_ID]))[0]).toMatchObject({ free: false, seller_name: "seller-ext" });
  });

  it("reports no third-party analytics when neither the product nor its seller has one for the receipt", async () => {
    const statements = answering({ purchases: [purchaseRow()], analytics: [], users: [sellerRow()] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect((await receiptPurchases(1n, [EXTERNAL_ID]))[0]!.has_third_party_analytics).toBe(false);
    expect(statements.find((statement) => statement.includes("FROM `third_party_analytics`"))).toContain("`location` IN ('receipt', 'all')");
  });

  it("lists each visible tracked purchase", async () => {
    answering({ purchases: [purchaseRow(), purchaseRow({ id: 6n })], users: [sellerRow()] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect((await receiptPurchases(1n, [EXTERNAL_ID, encrypt(6)])).map((receipt) => receipt.id)).toEqual([
      EXTERNAL_ID,
      encrypt(6),
    ]);
  });

  it("drops a membership that no longer grants access", async () => {
    answering({ purchases: [purchaseRow({ subscription_id: 4n })] });
    link.findUniqueOrThrow.mockResolvedValue(productRow({ flags: BLOCKS_ACCESS }));
    subscription.findUnique.mockResolvedValue({
      id: 4n,
      flags: 0n,
      cancelled_at: new Date("2020-01-01"),
      failed_at: null,
      ended_at: new Date("2020-01-01"),
      deactivated_at: new Date("2020-01-01"),
    });
    expect(await receiptPurchases(1n, [EXTERNAL_ID])).toEqual([]);
  });

  it("keeps a membership purchase whose subscription row is missing", async () => {
    answering({ purchases: [purchaseRow({ subscription_id: 4n })], users: [sellerRow()] });
    link.findUniqueOrThrow.mockResolvedValue(productRow({ flags: RECURRING }));
    subscription.findUnique.mockResolvedValue(null);
    expect(await receiptPurchases(1n, [EXTERNAL_ID])).toHaveLength(1);
  });
});
