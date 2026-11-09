import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import type { MobileInput } from "./mobile-api.ts";

const mocks = vi.hoisted(() => ({
  db: {
    urlRedirect: { findUnique: vi.fn() },
    purchase: { findUnique: vi.fn() },
    subscription: { findUnique: vi.fn() },
    link: { findUnique: vi.fn() },
  },
}));
vi.mock("../../lib/db.ts", () => ({ db: mocks.db }));

const { DOWNLOAD, FETCH_PLACEHOLDER_PRODUCTS, HLS_PLAYLIST, STREAM, deliveryGate } = await import("./mobile-url-redirects.ts");

describe("GET /mobile/url_redirects/fetch_placeholder_products", () => {
  it("is registered without an OAuth scope, as the Rails action only checks the mobile token", () => {
    expect(FETCH_PLACEHOLDER_PRODUCTS.method).toBe("GET");
    expect(FETCH_PLACEHOLDER_PRODUCTS.pattern).toBe("/mobile/url_redirects/fetch_placeholder_products");
    expect(FETCH_PLACEHOLDER_PRODUCTS.scopes).toBeNull();
  });

  it("answers 200 with an empty placeholder product list", async () => {
    const result = await FETCH_PLACEHOLDER_PRODUCTS.run({} as MobileInput, null);

    expect(result).toMatchObject({ status: 200, contentType: "application/json; charset=utf-8" });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ success: true, placeholder_products: [] });
  });
});

const NOW = new Date("2026-03-01T12:00:00Z");
const IS_RENTAL = 1n << 2n;
const IS_ACCESS_REVOKED = 1n << 24n;
const body = (result: unknown) => JSON.parse((result as { body: string }).body);

const redirect = (overrides: Record<string, unknown> = {}) => ({ id: 11n, token: "tok123", purchase_id: 5n, flags: 0n, rental_first_viewed_at: null, ...overrides });
const purchase = (overrides: Record<string, unknown> = {}) => ({ id: 5n, link_id: 3n, subscription_id: null, flags: 0n, stripe_refunded: null, chargeback_date: null, rental_expired: null, ...overrides });

describe("mobile delivery routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.db.urlRedirect.findUnique.mockResolvedValue(redirect());
    mocks.db.purchase.findUnique.mockResolvedValue(purchase());
    mocks.db.subscription.findUnique.mockResolvedValue(null);
    mocks.db.link.findUnique.mockResolvedValue({ id: 3n, flags: 0n });
  });

  it("registers stream, hls_playlist and download without an OAuth scope, as Rails only checks the mobile token", () => {
    expect([STREAM, HLS_PLAYLIST, DOWNLOAD].map(({ method, pattern, scopes }) => [method, pattern, scopes])).toEqual([
      ["GET", "/mobile/url_redirects/stream/:token/:product_file_id", null],
      ["GET", "/mobile/url_redirects/hls_playlist/:token/:product_file_id/index.m3u8", null],
      ["GET", "/mobile/url_redirects/download/:token/:product_file_id", null],
    ]);
  });

  it("answers 404 for an unknown token", async () => {
    mocks.db.urlRedirect.findUnique.mockResolvedValue(null);
    const result = await deliveryGate("nope", { writesRentalStamp: false, now: NOW });

    expect(result).toMatchObject({ status: 404, rescued: true });
    expect(body(result)).toEqual({ success: false, message: "Could not find url redirect" });
  });

  it.each([
    ["a refunded purchase", { stripe_refunded: true }],
    ["a charged back purchase", { chargeback_date: new Date("2026-02-01T00:00:00Z") }],
    ["a revoked purchase", { flags: IS_ACCESS_REVOKED }],
  ])("answers 404 for %s", async (_, overrides) => {
    mocks.db.purchase.findUnique.mockResolvedValue(purchase(overrides));

    expect(await deliveryGate("tok123", { writesRentalStamp: false, now: NOW })).toMatchObject({ status: 404 });
  });

  it("lets a reversed chargeback through", async () => {
    mocks.db.purchase.findUnique.mockResolvedValue(purchase({ chargeback_date: new Date("2026-02-01T00:00:00Z"), flags: 1n << 9n }));

    expect(await deliveryGate("tok123", { writesRentalStamp: false, now: NOW })).toBeNull();
  });

  it("answers 404 for a cancelled membership whose product blocks access after cancellation", async () => {
    mocks.db.link.findUnique.mockResolvedValue({ id: 3n, flags: 1n << 9n });
    mocks.db.purchase.findUnique.mockResolvedValue(purchase({ subscription_id: 9n }));
    mocks.db.subscription.findUnique.mockResolvedValue({ id: 9n, flags: 0n, link_id: 3n, cancelled_at: new Date("2026-01-01T00:00:00Z"), failed_at: null, ended_at: null });

    expect(await deliveryGate("tok123", { writesRentalStamp: false, now: NOW })).toMatchObject({ status: 404 });
  });

  it("lets a cancelled membership through when its product keeps access", async () => {
    mocks.db.purchase.findUnique.mockResolvedValue(purchase({ subscription_id: 9n }));
    mocks.db.subscription.findUnique.mockResolvedValue({ id: 9n, flags: 0n, link_id: 3n, cancelled_at: new Date("2026-01-01T00:00:00Z"), failed_at: null, ended_at: null });

    expect(await deliveryGate("tok123", { writesRentalStamp: false, now: NOW })).toBeNull();
  });

  it("answers 401 for an expired rental", async () => {
    mocks.db.urlRedirect.findUnique.mockResolvedValue(redirect({ flags: IS_RENTAL, rental_first_viewed_at: new Date("2026-02-01T00:00:00Z") }));
    mocks.db.purchase.findUnique.mockResolvedValue(purchase({ rental_expired: true }));
    const result = await deliveryGate("tok123", { writesRentalStamp: true, now: NOW });

    expect(result).toMatchObject({ status: 401, rescued: true });
    expect(body(result)).toEqual({ success: false, message: "Your rental has expired." });
  });

  it("hands back a playlist request that would stamp a rental's first view", async () => {
    mocks.db.urlRedirect.findUnique.mockResolvedValue(redirect({ flags: IS_RENTAL }));

    await expect(deliveryGate("tok123", { writesRentalStamp: true, now: NOW })).rejects.toBeInstanceOf(HandBackToRails);
    expect(await deliveryGate("tok123", { writesRentalStamp: false, now: NOW })).toBeNull();
  });

  it("hands back a request that passes the gate, since the file and its signed URL are Rails'", async () => {
    await expect(STREAM.run({ routeParams: { token: "tok123", product_file_id: "f" } } as unknown as MobileInput, null)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
