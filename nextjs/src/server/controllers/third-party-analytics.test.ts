import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandBackToRails, RoutingError, type ActionContext, type Chain } from "./application-controller.ts";
import { railsRequest } from "./rails-request.ts";
import { erasedCookies, index, OVERRIDE_ON_CLOSE_CODE, OVERRIDE_WINDOW_ACTIONS_CODE } from "./third-party-analytics.ts";

const mocks = vi.hoisted(() => ({ selectRows: vi.fn(), decrypt: vi.fn() }));
vi.mock("../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectRows: mocks.selectRows,
}));
vi.mock("../../lib/obfuscate-ids.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decrypt: mocks.decrypt,
}));

const request = (cookie?: string) =>
  railsRequest(new Request("http://analytics.test.gumroad.com/profile/seller", cookie ? { headers: { cookie } } : {}));
const erased = (cookie: string | undefined, guid: string | null) =>
  erasedCookies({ request: request(cookie), chain: { guid } as Chain }).map((line) => line.split(";")[0]);

describe("ThirdPartyAnalyticsController#profile cookie erasure", () => {
  it("expires every cookie the visitor sent", () => {
    expect(erased("foo=bar; baz=1", null)).toEqual(["foo=", "baz="]);
  });

  it("expires the guid it minted after the cookies the visitor sent", () => {
    expect(erased("foo=bar", "minted")).toEqual(["foo=", "_gumroad_guid="]);
  });

  it("expires the guid once when the visitor sent it", () => {
    expect(erased("_gumroad_guid=abc", "minted")).toEqual(["_gumroad_guid="]);
  });

  it("expires the minted guid of a visitor with no cookies", () => {
    expect(erased(undefined, "minted")).toEqual(["_gumroad_guid="]);
  });

  it("writes the expiry the way Rack does", () => {
    expect(erasedCookies({ request: request("foo=bar"), chain: { guid: null } as Chain })).toEqual([
      "foo=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; httponly; samesite=lax",
    ]);
  });
});

describe("window overrides", () => {
  it("are the two script blocks the Rails controller defines", () => {
    expect(OVERRIDE_WINDOW_ACTIONS_CODE).toContain("window.alert = function() {}");
    expect(OVERRIDE_ON_CLOSE_CODE).toContain("window.onbeforeunload = null");
  });
});

describe("ThirdPartyAnalyticsController#index placeholders", () => {
  const SNIPPET = "v=$VALUE c=$CURRENCY o=$ORDER v=$VALUE";
  const action = { request: request(), chain: { guid: null } as Chain } as ActionContext;

  // selectRows answers the product, its snippets, the seller's snippets, then the sale.
  function serve(query: string, options: { currency?: string | null; cents?: number | null; sale?: boolean } = {}) {
    const { currency = "usd", cents = 1550, sale = true } = options;
    mocks.selectRows
      .mockResolvedValueOnce([{ id: 1n, user_id: 2n, price_currency_type: currency }])
      .mockResolvedValueOnce([{ analytics_code: SNIPPET }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(sale ? [{ displayed_price_cents: cents }] : []);
    return index("abc", new URL(`http://analytics.test.gumroad.com/abc${query}`), action);
  }

  beforeEach(() => {
    mocks.selectRows.mockReset();
    mocks.decrypt.mockReset().mockReturnValue(7);
  });

  it("fills in every occurrence of the value, the upper-cased currency and the order", async () => {
    const { body } = await serve("?purchase_id=Xy_1-=");

    expect(body).toContain("v=15.50 c=USD o=Xy_1-= v=15.50");
  });

  it("drops the cents of a whole price and groups the thousands", async () => {
    expect((await serve("?purchase_id=x", { cents: 500_000 })).body).toContain("v=5,000 ");
  });

  it("formats the price in the currency of the product", async () => {
    expect((await serve("?purchase_id=x", { currency: "jpy", cents: 1250 })).body).toContain("v=1,250 c=JPY");
  });

  it("looks the sale up among the sales of the product by its decrypted id", async () => {
    await serve("?purchase_id=x");

    expect(mocks.decrypt).toHaveBeenCalledWith("x");
    const lookup = mocks.selectRows.mock.calls[3]![0] as { values: unknown[] };
    // The product's id, then the decrypted purchase id.
    expect(lookup.values).toEqual([1n, 7]);
  });

  it("leaves the placeholders of a blank purchase_id", async () => {
    const { body } = await serve("?purchase_id=");

    expect(body).toContain(SNIPPET);
    expect(mocks.selectRows).toHaveBeenCalledTimes(3);
  });

  it("answers Not Found for a purchase_id that does not decrypt", async () => {
    mocks.decrypt.mockReturnValue(null);

    await expect(serve("?purchase_id=x", { sale: false })).rejects.toBeInstanceOf(RoutingError);
  });

  it("answers Not Found for a sale of another product", async () => {
    await expect(serve("?purchase_id=x", { sale: false })).rejects.toBeInstanceOf(RoutingError);
  });

  it("hands back a purchase_id outside an external id", async () => {
    await expect(serve("?purchase_id=a%20b")).rejects.toBeInstanceOf(HandBackToRails);
  });

  it("hands back a sale without a price", async () => {
    await expect(serve("?purchase_id=x", { cents: null })).rejects.toBeInstanceOf(HandBackToRails);
  });
});
