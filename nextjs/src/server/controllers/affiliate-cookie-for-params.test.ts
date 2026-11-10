import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], lookups: 0 }));

vi.mock("../models/sql.ts", () => ({
  column: (_table: string, name: string) => name,
  table: (name: string) => name,
  selectRows: async () => {
    mocks.lookups += 1;
    return mocks.rows.shift() ?? [];
  },
}));
vi.mock("../../lib/obfuscate-ids.ts", () => ({
  // decryptNumeric(n) = n - 1000 keeps the tests readable.
  decryptNumeric: (id: number) => id - 1000,
  encryptNumeric: (id: number) => id + 1000,
  encrypt: (id: bigint | number) => `enc${id}`,
}));
vi.mock("./application-controller.ts", async () => {
  class HandBackToRails extends Error {}
  class RoutingError extends Error {}
  return { HandBackToRails, RoutingError, allDomain: () => "example.com", processAction: vi.fn() };
});
vi.mock("../models/product-affiliate.ts", () => ({ PRODUCT_AFFILIATES: "product_affiliates" }));
vi.mock("../page-props/domain.ts", () => ({ domainConfig: () => ({}) }));
vi.mock("../presenters/product.ts", () => ({ longUrl: () => "", subdomainWithProtocol: () => null }));
vi.mock("../presenters/product-reads.ts", () => ({ findUserById: async () => null }));

import { affiliateCookieForParams } from "./affiliate-redirect.ts";
import { HandBackToRails } from "./application-controller.ts";
import type { RailsRequest } from "./rails-request.ts";

const request = (queryString: string) => ({ queryString, host: "seller.example.com" }) as RailsRequest;
const NOW = new Date("2026-01-01T00:00:00Z");
const affiliate = (over: Record<string, unknown> = {}) => ({
  id: 7n,
  type: "DirectAffiliate",
  deleted_at: null,
  seller_id: 1n,
  affiliate_user_id: 2n,
  ...over,
});

describe("affiliateCookieForParams", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.lookups = 0;
  });

  it("sets the affiliate cookie for ?affiliate_id=", async () => {
    mocks.rows = [[affiliate()]];
    const cookie = await affiliateCookieForParams(request("affiliate_id=1007"), NOW);
    expect(cookie).toContain("_gumroad_affiliate_id_enc7=1767225600");
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("domain=example.com");
  });

  it("reads the short ?a= param and prefers a present affiliate_id", async () => {
    mocks.rows = [[affiliate()]];
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toContain("_gumroad_affiliate_id_enc7");
    mocks.rows = [[affiliate({ id: 9n })]];
    expect(await affiliateCookieForParams(request("affiliate_id=1009&a=1007"), NOW)).toContain("enc9");
    mocks.rows = [[affiliate({ id: 9n })]];
    expect(await affiliateCookieForParams(request("affiliate_id=&a=1009"), NOW)).toContain("enc9");
  });

  it("gives a global affiliate the 7 day cookie and a direct one the 30 day cookie", async () => {
    mocks.rows = [[affiliate({ type: "GlobalAffiliate" })]];
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toContain("expires=Thu, 08 Jan 2026");
    mocks.rows = [[affiliate()]];
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toContain("expires=Sat, 31 Jan 2026");
  });

  it("sets no cookie without a param, with a zero id, or for an unknown or deleted affiliate", async () => {
    expect(await affiliateCookieForParams(request("x=1"), NOW)).toBeNull();
    expect(await affiliateCookieForParams(request("a=abc"), NOW)).toBeNull();
    expect(await affiliateCookieForParams(request("a"), NOW)).toBeNull();
    expect(mocks.lookups).toBe(0);
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toBeNull();
    mocks.rows = [[affiliate({ deleted_at: NOW })], []];
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toBeNull();
  });

  it("credits the latest alive direct account of the seller when the account was deleted", async () => {
    mocks.rows = [[affiliate({ deleted_at: NOW })], [affiliate({ id: 8n })]];
    expect(await affiliateCookieForParams(request("a=1007"), NOW)).toContain("enc8");
  });

  it("hands a nested param and an id beyond the obfuscated range back to Rails", async () => {
    await expect(affiliateCookieForParams(request("a[]=1007"), NOW)).rejects.toBeInstanceOf(HandBackToRails);
    await expect(affiliateCookieForParams(request("affiliate_id%5Bx%5D=1"), NOW)).rejects.toBeInstanceOf(
      HandBackToRails,
    );
    await expect(affiliateCookieForParams(request("a=99999999999"), NOW)).rejects.toBeInstanceOf(HandBackToRails);
  });
});
