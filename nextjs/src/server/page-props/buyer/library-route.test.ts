import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "library-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { link, loadSellerContext, libraryProps } = vi.hoisted(() => ({
  link: { findUniqueOrThrow: vi.fn() },
  loadSellerContext: vi.fn(),
  libraryProps: vi.fn(),
}));
vi.mock("../../../lib/db.ts", () => ({ db: { link, subscription: { findUnique: vi.fn() } } }));
vi.mock("../../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../../policies/seller-context.ts")>()),
  loadSellerContext,
}));
vi.mock("./library.ts", async (original) => ({ ...(await original<typeof import("./library.ts")>()), libraryProps }));

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { HandBackToRails, type Chain } from "../../controllers/application-controller.ts";
import { setSqlClient } from "../../models/sql.ts";
import type { ActionContext } from "../load-page.ts";

import { BUYER_PAGES } from "./pages.ts";

const EXTERNAL_ID = encrypt(5);
const user = { id: 1n, email: "buyer@example.com", unconfirmed_email: null, confirmed_at: new Date("2020-01-01") };
const page = BUYER_PAGES["/library"]!;

const chain = (queryString: string) =>
  ({
    request: { headers: new Headers(), queryString, path: "/library", url: `https://example.com/library?${queryString}` },
    auth: { context: { loggedInUser: user, impersonatedUser: null, currentSeller: user } },
    session: { data: {} },
  }) as unknown as Chain;

function answering(rows: { users?: unknown[]; purchases?: unknown[] }) {
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      if (query.sql.includes("FROM `third_party_analytics`")) return [];
      if (query.sql.includes("`users`.*")) return rows.users ?? [];
      if (query.sql.includes("`purchases`.*")) return rows.purchases ?? [];
      throw new Error(`unexpected statement: ${query.sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

const seller = (overrides: Record<string, unknown> = {}) => ({ id: 3n, google_analytics_id: null, facebook_pixel_id: null, json_data: null, ...overrides });

beforeEach(() => {
  loadSellerContext.mockReset();
  loadSellerContext.mockResolvedValue({ user, seller: user, memberships: [] });
  libraryProps.mockReset();
  libraryProps.mockResolvedValue({ results: [] });
  link.findUniqueOrThrow.mockReset();
});

describe("GET /library?purchase_id=", () => {
  it("lets the page render for a purchase whose seller has no pixel ids", async () => {
    answering({ users: [seller()] });
    const outcome = await page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`));
    expect(outcome).toEqual({ state: {} });
  });

  it("hands the request back when the purchase's seller has a Facebook pixel", async () => {
    answering({ users: [seller({ facebook_pixel_id: "123" })] });
    await expect(page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("renders the visible purchase as a receipt purchase and leaves purchase_analytics empty", async () => {
    answering({ purchases: [{ id: 5n, email: "buyer@example.com", link_id: 9n, subscription_id: null, flags: 0n }] });
    link.findUniqueOrThrow.mockResolvedValue({ id: 9n, user_id: 3n, unique_permalink: "abc", flags: 0n });
    const props = await page.props({}, {
      context: { loggedInUser: user, impersonatedUser: null },
      meta: { set: vi.fn() },
      url: new URL(`https://example.com/library?purchase_id=${EXTERNAL_ID}`),
    } as unknown as ActionContext);
    expect(props).toMatchObject({
      purchase_analytics: {},
      receipt_purchases: [{ id: EXTERNAL_ID, email: "buyer@example.com", permalink: "abc", has_third_party_analytics: false }],
    });
  });

  it("renders no receipt purchases without the parameter", async () => {
    answering({});
    const props = await page.props({}, {
      context: { loggedInUser: user, impersonatedUser: null },
      meta: { set: vi.fn() },
      url: new URL("https://example.com/library"),
    } as unknown as ActionContext);
    expect(props).toMatchObject({ purchase_analytics: {}, receipt_purchases: [] });
  });
});
