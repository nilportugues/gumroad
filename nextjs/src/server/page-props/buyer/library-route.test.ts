import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "library-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

const { link, loadSellerContext, libraryProps, buyerCurrencyDisplayProps } = vi.hoisted(() => ({
  link: { findUniqueOrThrow: vi.fn() },
  buyerCurrencyDisplayProps: vi.fn(),
  loadSellerContext: vi.fn(),
  libraryProps: vi.fn(),
}));
vi.mock("../../../lib/db.ts", () => ({ db: { link, subscription: { findUnique: vi.fn() } } }));
vi.mock("../../policies/seller-context.ts", async (original) => ({
  ...(await original<typeof import("../../policies/seller-context.ts")>()),
  loadSellerContext,
}));
vi.mock("../../presenters/product.ts", async (original) => ({
  ...(await original<typeof import("../../presenters/product.ts")>()),
  buyerCurrencyDisplayProps,
}));
vi.mock("./library.ts", async (original) => ({ ...(await original<typeof import("./library.ts")>()), libraryProps }));

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { NotPortedError } from "../not-ported.ts";
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

function answering(rows: { users?: unknown[]; purchases?: unknown[]; links?: unknown[]; presentments?: unknown[] }) {
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      if (query.sql.includes("FROM `third_party_analytics`")) return [];
      if (query.sql.includes("FROM `purchase_presentments`")) return rows.presentments ?? [];
      if (query.sql.includes("`links`.*")) return rows.links ?? [];
      if (query.sql.includes("`users`.*")) return rows.users ?? [];
      if (query.sql.includes("`purchases`.*")) return rows.purchases ?? [];
      throw new Error(`unexpected statement: ${query.sql}`);
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

const seller = (overrides: Record<string, unknown> = {}) => ({ id: 3n, external_id: "seller-ext", flags: 0n, google_analytics_id: null, facebook_pixel_id: null, json_data: null, ...overrides });

const purchase = (overrides: Record<string, unknown> = {}) => ({ id: 5n, email: "buyer@example.com", link_id: 9n, subscription_id: null, flags: 0n, displayed_price_currency_type: "usd", displayed_price_cents: 1500, quantity: 2, tax_cents: 150, ...overrides });
const product = (overrides: Record<string, unknown> = {}) => ({ id: 9n, user_id: 3n, name: "Course", unique_permalink: "abc", price_currency_type: "usd", flags: 0n, ...overrides });
const render = (query: string) =>
  page.props({}, {
    context: { loggedInUser: user, impersonatedUser: null },
    meta: { set: vi.fn() },
    url: new URL(`https://example.com/library?${query}`),
  } as unknown as ActionContext) as Promise<Record<string, unknown>>;

beforeEach(() => {
  buyerCurrencyDisplayProps.mockReset();
  buyerCurrencyDisplayProps.mockResolvedValue({ display_mode: "default" });
  loadSellerContext.mockReset();
  loadSellerContext.mockResolvedValue({ user, seller: user, memberships: [] });
  libraryProps.mockReset();
  libraryProps.mockResolvedValue({ results: [] });
  link.findUniqueOrThrow.mockReset();
  link.findUniqueOrThrow.mockResolvedValue({ id: 9n, user_id: 3n, unique_permalink: "abc", flags: 0n });
});

describe("GET /library?purchase_id=", () => {
  it("lets the page render for a purchase whose seller has no pixel ids", async () => {
    answering({ users: [seller()] });
    const outcome = await page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`));
    expect(outcome).toEqual({ state: {} });
  });

  it("lets the page render for a purchase whose seller has a Facebook pixel", async () => {
    answering({ users: [seller({ facebook_pixel_id: "123" })], purchases: [purchase()], links: [product()] });
    expect(await page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`))).toEqual({ state: {} });
  });

  it("hands the request back for a purchase priced in another currency", async () => {
    answering({ users: [seller({ facebook_pixel_id: "123" })], purchases: [purchase({ displayed_price_currency_type: "eur" })], links: [product()] });
    await expect(page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands the request back for a purchase charged in the buyer's currency", async () => {
    answering({ users: [seller({ facebook_pixel_id: "123" })], purchases: [purchase()], links: [product()], presentments: [{ 1: 1 }] });
    await expect(page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands the request back for a seller showing buyer-local prices", async () => {
    buyerCurrencyDisplayProps.mockRejectedValue(new NotPortedError("buyer local currency"));
    answering({ users: [seller({ google_analytics_id: "UA-1" })], purchases: [purchase()], links: [product()] });
    await expect(page.options!.filters!(chain(`purchase_id=${EXTERNAL_ID}`))).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("renders the seller's analytics event for the tracked purchase", async () => {
    answering({ users: [seller({ google_analytics_id: "UA-1", json_data: JSON.stringify({ tiktok_pixel_id: "TT1" }) })], purchases: [purchase()], links: [product()] });
    expect((await render(`purchase_id=${EXTERNAL_ID}`)).purchase_analytics).toEqual({
      [EXTERNAL_ID]: {
        seller_id: "seller-ext",
        analytics: { google_analytics_id: "UA-1", facebook_pixel_id: null, tiktok_pixel_id: "TT1", free_sales: true },
        purchase_event: {
          permalink: "abc",
          purchase_external_id: EXTERNAL_ID,
          product_name: "Course",
          value: 1500,
          currency: "usd",
          quantity: 2,
          tax: "1.50",
          buyer_currency_display: { display_mode: "default" },
        },
      },
    });
  });

  it("renders whole-dollar tax without cents and no analytics for a seller without pixel ids", async () => {
    answering({ users: [seller({ facebook_pixel_id: "9" })], purchases: [purchase({ tax_cents: 200 })], links: [product()] });
    const event = ((await render(`purchase_id=${EXTERNAL_ID}`)).purchase_analytics as Record<string, { purchase_event: { tax: string } }>)[EXTERNAL_ID]!.purchase_event;
    expect(event.tax).toBe("2");
    answering({ users: [seller()], purchases: [purchase()], links: [product()] });
    expect((await render(`purchase_id=${EXTERNAL_ID}`)).purchase_analytics).toEqual({});
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
