import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "library-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { link, subscription } = vi.hoisted(() => ({
  link: { findUniqueOrThrow: vi.fn() },
  subscription: { findUnique: vi.fn() },
}));
vi.mock("../../../lib/db.ts", () => ({ db: { link, subscription } }));

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails } from "../../controllers/application-controller.ts";
import { LinkFlags } from "../../models/link.ts";
import { setSqlClient } from "../../models/sql.ts";

import { assertLibrarySupported, receiptPurchases } from "./library.ts";

const EXTERNAL_ID = encrypt(5);
const RECURRING = LinkFlags.set(0n, "is_recurring_billing", true);
const BLOCKS_ACCESS = LinkFlags.set(RECURRING, "block_access_after_membership_cancellation", true);

type Answers = { users?: Record<string, unknown>[]; purchases?: Record<string, unknown>[]; analytics?: unknown[] };

function answering({ users = [], purchases = [], analytics = [] }: Answers) {
  const statements: string[] = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      statements.push(query.sql);
      if (query.sql.includes("FROM `third_party_analytics`")) return analytics;
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
  link_id: 9n,
  subscription_id: null,
  flags: 0n,
  ...overrides,
});
const productRow = (overrides: Record<string, unknown> = {}) => ({ id: 9n, user_id: 3n, unique_permalink: "abc", flags: 0n, ...overrides });
const sellerRow = (overrides: Record<string, unknown> = {}) => ({ id: 3n, google_analytics_id: null, facebook_pixel_id: null, json_data: null, ...overrides });
const params = { bundles: "", subscriptionsOnly: false, purchaseId: EXTERNAL_ID };

beforeEach(() => {
  link.findUniqueOrThrow.mockReset();
  subscription.findUnique.mockReset();
});

describe("assertLibrarySupported with a tracked purchase", () => {
  it("serves a purchase whose seller has no pixel ids", async () => {
    const statements = answering({ users: [sellerRow()] });
    await expect(assertLibrarySupported(1n, params)).resolves.toBeUndefined();
    expect(statements[0]).toContain("`purchases`.`purchaser_id` = ?");
  });

  it("serves an id that is not one of the buyer's purchases", async () => {
    answering({ users: [] });
    await expect(assertLibrarySupported(1n, params)).resolves.toBeUndefined();
  });

  it("makes no query for a missing, blank or undecodable id", async () => {
    const statements = answering({});
    await assertLibrarySupported(1n, { ...params, purchaseId: undefined });
    await assertLibrarySupported(1n, { ...params, purchaseId: "" });
    await assertLibrarySupported(1n, { ...params, purchaseId: "not an id!" });
    expect(statements).toEqual([]);
  });

  it.each([
    ["Google Analytics", { google_analytics_id: "UA-1" }],
    ["Facebook", { facebook_pixel_id: "123" }],
    ["an empty but present Google Analytics id", { google_analytics_id: "" }],
  ])("hands back when the seller has %s", async (_, columns) => {
    answering({ users: [sellerRow(columns)] });
    await expect(assertLibrarySupported(1n, params)).rejects.toBeInstanceOf(HandBackToRails);
  });
});

describe("receiptPurchases", () => {
  it("is empty without a tracked purchase", async () => {
    const statements = answering({});
    expect(await receiptPurchases(1n, undefined)).toEqual([]);
    expect(statements).toEqual([]);
  });

  it("is empty for a purchase that is not visible in the library", async () => {
    answering({ purchases: [] });
    expect(await receiptPurchases(1n, EXTERNAL_ID)).toEqual([]);
  });

  it("lists the visible purchase with its email, permalink and receipt analytics flag", async () => {
    answering({ purchases: [purchaseRow()], analytics: [{ 1: 1 }] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect(await receiptPurchases(1n, EXTERNAL_ID)).toEqual([
      { id: EXTERNAL_ID, email: "buyer@example.com", permalink: "abc", has_third_party_analytics: true },
    ]);
  });

  it("reports no third-party analytics when neither the product nor its seller has one for the receipt", async () => {
    const statements = answering({ purchases: [purchaseRow()], analytics: [] });
    link.findUniqueOrThrow.mockResolvedValue(productRow());
    expect((await receiptPurchases(1n, EXTERNAL_ID))[0]!.has_third_party_analytics).toBe(false);
    expect(statements.at(-1)).toContain("`location` IN ('receipt', 'all')");
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
    expect(await receiptPurchases(1n, EXTERNAL_ID)).toEqual([]);
  });

  it("keeps a membership purchase whose subscription row is missing", async () => {
    answering({ purchases: [purchaseRow({ subscription_id: 4n })] });
    link.findUniqueOrThrow.mockResolvedValue(productRow({ flags: RECURRING }));
    subscription.findUnique.mockResolvedValue(null);
    expect(await receiptPurchases(1n, EXTERNAL_ID)).toHaveLength(1);
  });
});
