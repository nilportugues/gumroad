import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  affiliateCookieForParams: vi.fn(),
  hasCuratedProductSources: vi.fn(),
  autocompleteResults: vi.fn(),
}));

vi.mock("./affiliate-redirect.ts", () => ({ affiliateCookieForParams: mocks.affiliateCookieForParams }));
vi.mock("../auth/resolve.ts", () => ({ railsLoggedInUser: () => null }));
vi.mock("../page-props/audience/events.ts", () => ({ remoteIp: () => null }));
vi.mock("../page-props/discover/discover.ts", () => ({
  autocompleteResults: mocks.autocompleteResults,
  blackFridayFeatureActive: async () => false,
  deferredPropsPortable: async () => true,
  hasCuratedProductSources: mocks.hasCuratedProductSources,
  isAutocompleteOnlyRequest: (headers: Headers) => headers.has("x-autocomplete"),
  isDeferredOnlyRequest: () => false,
  prepareSearch: async () => ({}),
  requestedDeferredProps: () => [],
  requestParams: () => ({}),
  searchResults: async () => ({}),
}));
vi.mock("./application-controller.ts", () => ({ HandBackToRails: class HandBackToRails extends Error {} }));

import { discoverFilters } from "./discover-page.ts";

const NOW = new Date("2026-01-01T00:00:00Z");
const chainOf = (headers: Record<string, string> = {}) => {
  const cookies: string[] = [];
  const request = { path: "/discover", queryString: "a=5", headers: new Headers(headers), cookies: new Map(), host: "gumroad.example.com" };
  const chain = { request, auth: { context: { currentSeller: null } }, guid: null, now: NOW, cookies };
  return { chain: chain as never, request, cookies };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hasCuratedProductSources.mockResolvedValue(false);
  mocks.autocompleteResults.mockResolvedValue([]);
});

describe("discoverFilters affiliate cookie", () => {
  it("sets the affiliate cookie and still serves the page", async () => {
    mocks.affiliateCookieForParams.mockResolvedValue("cookie-line");
    const { chain, request, cookies } = chainOf();
    await expect(discoverFilters(chain)).resolves.toEqual({ state: {} });
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
