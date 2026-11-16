import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  affiliateCookieForParams: vi.fn(),
  curatedProducts: vi.fn(),
  prepareSearch: vi.fn(),
  autocompleteResults: vi.fn(),
  blackFridayFeatureActive: vi.fn(),
  blackFridayStats: vi.fn(),
  isDeferredOnlyRequest: vi.fn(),
}));

vi.mock("./affiliate-redirect.ts", () => ({ affiliateCookieForParams: mocks.affiliateCookieForParams }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: () => null }));
vi.mock("../page-props/audience/events.ts", () => ({ remoteIp: () => null }));
vi.mock("../page-props/discover/discover.ts", () => ({
  autocompleteResults: mocks.autocompleteResults,
  BLACK_FRIDAY_CODE: "BLACKFRIDAY2025",
  blackFridayFeatureActive: mocks.blackFridayFeatureActive,
  deferredPropsPortable: async () => true,
  isAutocompleteOnlyRequest: (headers: Headers) => headers.has("x-autocomplete"),
  isDeferredOnlyRequest: mocks.isDeferredOnlyRequest,
  prepareSearch: mocks.prepareSearch,
  requestedDeferredProps: () => [],
  requestParams: () => ({}),
  searchResults: async () => ({}),
}));
vi.mock("../page-props/discover/curated-products.ts", () => ({ curatedProducts: mocks.curatedProducts }));
vi.mock("../page-props/discover/black-friday-stats.ts", () => ({ blackFridayStats: mocks.blackFridayStats }));
vi.mock("./application-controller.ts", () => ({ HandBackToRails: class HandBackToRails extends Error {} }));

import { NotPortedError } from "../page-props/not-ported.ts";

import { HandBackToRails } from "./application-controller.ts";
import { discoverFilters } from "./discover-page.ts";

const NOW = new Date("2026-01-01T00:00:00Z");
const chainOf = (headers: Record<string, string> = {}) => {
  const cookies: string[] = [];
  const request = {
    path: "/discover",
    queryString: "a=5",
    headers: new Headers(headers),
    cookies: new Map(),
    host: "gumroad.example.com",
  };
  const chain = { request, auth: { context: { currentSeller: null } }, guid: null, now: NOW, cookies };
  return { chain: chain as never, request, cookies };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.curatedProducts.mockResolvedValue([]);
  mocks.prepareSearch.mockResolvedValue({});
  mocks.autocompleteResults.mockResolvedValue([]);
  mocks.blackFridayFeatureActive.mockResolvedValue(false);
  mocks.isDeferredOnlyRequest.mockReturnValue(false);
});

describe("discoverFilters affiliate cookie", () => {
  it("sets the affiliate cookie and still serves the page", async () => {
    mocks.affiliateCookieForParams.mockResolvedValue("cookie-line");
    const { chain, request, cookies } = chainOf();
    await expect(discoverFilters(chain)).resolves.toEqual({ state: { blackFridayStats: null } });
    expect(cookies).toEqual(["cookie-line"]);
    expect(mocks.affiliateCookieForParams).toHaveBeenCalledWith(request, NOW);
  });

  it("sets no cookie when the affiliate earns none", async () => {
    mocks.affiliateCookieForParams.mockResolvedValue(null);
    const { chain, cookies } = chainOf();
    await discoverFilters(chain);
    expect(cookies).toEqual([]);
  });

  it("sets the cookie on a search box request too", async () => {
    mocks.affiliateCookieForParams.mockResolvedValue("cookie-line");
    const { chain, cookies } = chainOf({ "x-autocomplete": "1" });
    await expect(discoverFilters(chain)).resolves.toEqual({ state: { autocomplete: [] } });
    expect(cookies).toEqual(["cookie-line"]);
  });

  it("propagates the hand-back of a nested affiliate param", async () => {
    mocks.affiliateCookieForParams.mockRejectedValue(new Error("hand back"));
    await expect(discoverFilters(chainOf().chain)).rejects.toThrow("hand back");
  });
});

describe("discoverFilters Black Friday", () => {
  const STATS = { active_deals_count: 2, revenue_cents: 950, average_discount_percentage: 43 };

  beforeEach(() => {
    mocks.affiliateCookieForParams.mockResolvedValue(null);
  });

  it("hands the stats of the Black Friday code to the page when the feature is on", async () => {
    mocks.blackFridayFeatureActive.mockResolvedValue(true);
    mocks.blackFridayStats.mockResolvedValue(STATS);
    await expect(discoverFilters(chainOf().chain)).resolves.toEqual({ state: { blackFridayStats: STATS } });
    expect(mocks.blackFridayStats).toHaveBeenCalledWith("BLACKFRIDAY2025", NOW);
  });

  it("reads no stats when the feature is off", async () => {
    await discoverFilters(chainOf().chain);
    expect(mocks.blackFridayStats).not.toHaveBeenCalled();
  });

  it("reads no stats for a deferred-only request, whose props leave the lambdas out", async () => {
    mocks.blackFridayFeatureActive.mockResolvedValue(true);
    mocks.isDeferredOnlyRequest.mockReturnValue(true);
    await expect(discoverFilters(chainOf().chain)).resolves.toEqual({ state: {} });
    expect(mocks.blackFridayStats).not.toHaveBeenCalled();
  });

  it("hands back when the stats cannot be computed", async () => {
    mocks.blackFridayFeatureActive.mockResolvedValue(true);
    mocks.blackFridayStats.mockRejectedValue(new NotPortedError("tiers"));
    await expect(discoverFilters(chainOf().chain)).rejects.toThrow();
  });
});

describe("discoverFilters curated products", () => {
  beforeEach(() => {
    mocks.affiliateCookieForParams.mockResolvedValue(null);
  });

  it("prepares the search with the visitor's curated products", async () => {
    const curated = [{ id: 20n }];
    mocks.curatedProducts.mockResolvedValue(curated);
    const { chain, request } = chainOf();
    await discoverFilters(chain);
    expect(mocks.curatedProducts).toHaveBeenCalledWith(null, null);
    expect(mocks.prepareSearch).toHaveBeenCalledWith(request, null, curated);
  });

  it("hands back a visitor whose curated products Rails samples at random, before preparing the search", async () => {
    mocks.curatedProducts.mockRejectedValue(new NotPortedError("sampled"));
    await expect(discoverFilters(chainOf().chain)).rejects.toBeInstanceOf(HandBackToRails);
    expect(mocks.prepareSearch).not.toHaveBeenCalled();
  });

  it("lets a failure that is not a hand-back through", async () => {
    mocks.curatedProducts.mockRejectedValue(new Error("db down"));
    await expect(discoverFilters(chainOf().chain)).rejects.toThrow("db down");
  });

  it("reads no curated products for a search box request", async () => {
    await discoverFilters(chainOf({ "x-autocomplete": "1" }).chain);
    expect(mocks.curatedProducts).not.toHaveBeenCalled();
  });
});
