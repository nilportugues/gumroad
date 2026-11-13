import { describe, expect, it } from "vitest";

import { HandBackToRails } from "../../controllers/application-controller.ts";
import { defer, lazy, resolveLazyProps } from "../lazy-props.ts";

import { affiliatedParams } from "./affiliated.ts";
import {
  assertPriceSupported,
  assertTableSupported,
  listingParams,
  priceFormattedVerbose,
  type LinkRow,
  type RowData,
} from "./listing.ts";

describe("listingParams", () => {
  it("reads the search, pages and sorts, ignoring a sort key the page does not know", () => {
    const params = listingParams({
      queryString:
        "query=zine&products_page=2&products_sort_key=revenue&products_sort_direction=desc&memberships_sort_key=bogus",
    });
    expect(params).toEqual({
      query: "zine",
      products: { page: "2", sort: { key: "revenue", direction: "desc" } },
      memberships: { page: null, sort: null },
    });
  });

  it("takes the last value of a repeated key and any direction but desc as asc", () => {
    const params = listingParams({
      queryString: "products_page=1&products_page=3&products_sort_key=name&products_sort_direction=sideways",
    });
    expect(params.products).toEqual({ page: "3", sort: { key: "name", direction: "asc" } });
  });

  it("tells an absent search (nil) from an empty one", () => {
    expect(listingParams({ queryString: "" }).query).toBeNull();
    expect(listingParams({ queryString: "query=" }).query).toBe("");
  });
});

describe("assertTableSupported", () => {
  it("accepts the SQL sorts and a numeric page", () => {
    expect(() => assertTableSupported({ page: "-3", sort: { key: "status", direction: "asc" } })).not.toThrow();
    expect(() => assertTableSupported({ page: null, sort: null })).not.toThrow();
  });

  it("hands a sort that Elasticsearch performs to Rails", () => {
    expect(() => assertTableSupported({ page: null, sort: { key: "display_price_cents", direction: "asc" } })).toThrow(
      HandBackToRails,
    );
  });

  it("hands a page that Pagy would not read like String#to_i to Rails", () => {
    expect(() => assertTableSupported({ page: "2abc", sort: null })).toThrow(HandBackToRails);
  });
});

describe("assertPriceSupported", () => {
  const empty: RowData = { prices: [], variants: [], categories: new Map(), thumbnails: new Map() };
  const product = (overrides: Partial<LinkRow>) =>
    ({
      id: 1n,
      flags: 0n,
      price_currency_type: "usd",
      purchase_type: 0,
      duration_in_months: null,
      ...overrides,
    }) as LinkRow;

  it("accepts a USD buy-only product", () => {
    expect(() => assertPriceSupported(product({}), empty)).not.toThrow();
  });

  it("accepts a product listed in a currency the money gem knows", () => {
    for (const code of ["eur", "jpy", "gbp"])
      expect(() => assertPriceSupported(product({ price_currency_type: code }), empty)).not.toThrow();
  });

  it("hands a currency the gem does not know, and rentals, to Rails", () => {
    expect(() => assertPriceSupported(product({ price_currency_type: "xyz" }), empty)).toThrow(HandBackToRails);
    expect(() => assertPriceSupported(product({ purchase_type: 2 }), empty)).toThrow(HandBackToRails);
  });
});

describe("priceFormattedVerbose", () => {
  const priced = (currency: string, cents: number, flags = 0n) => {
    const row = {
      id: 1n,
      flags,
      price_currency_type: currency,
      subscription_duration: null,
      customizable_price: false,
    } as unknown as LinkRow;
    const data = {
      prices: [{ link_id: 1, variant_id: null, price_cents: cents, flags: 0, recurrence: null }],
      variants: [],
      categories: new Map(),
      thumbnails: new Map(),
    } as unknown as RowData;
    return priceFormattedVerbose(row, data);
  };

  it("quotes a price in the symbol and scale of the product's currency", () => {
    expect(priced("eur", 1050)).toBe("\u20ac10.50");
    expect(priced("jpy", 1500)).toBe("\u00a51,500");
    expect(priced("gbp", 250)).toBe("\u00a32.50");
  });

  it("keeps the 99 cent shorthand to the dollar", () => {
    expect(priced("usd", 99)).toBe("99\u00a2");
    expect(priced("gbp", 99)).toBe("\u00a30.99");
  });
});

describe("affiliatedParams", () => {
  it("reads the nested sort parameters Rack builds", () => {
    expect(affiliatedParams("query=a&page=2&sort%5Bkey%5D=revenue&sort%5Bdirection%5D=desc")).toEqual({
      query: "a",
      page: "2",
      sort: { key: "revenue", direction: "desc" },
    });
  });

  it("hands any other nested parameter to Rails", () => {
    expect(() => affiliatedParams("filter[a]=1")).toThrow(HandBackToRails);
    expect(() => affiliatedParams("sort=name")).toThrow(HandBackToRails);
  });
});

describe("deferred props", () => {
  const props = () => ({
    plain: 1,
    cheap: lazy(() => 2),
    products_data: defer(() => "p", "data"),
    memberships_data: defer(() => "m", "data"),
    other: defer(() => "o"),
  });

  it("leaves deferred props out of the first response and lists them by group", async () => {
    const resolved = await resolveLazyProps(props(), null);
    expect(resolved.props).toEqual({ plain: 1, cheap: 2 });
    expect(resolved.deferredProps).toEqual({ data: ["products_data", "memberships_data"], default: ["other"] });
  });

  it("answers a partial reload with the requested deferred props and no deferredProps", async () => {
    const resolved = await resolveLazyProps(props(), {
      only: ["products_data", "memberships_data"],
      except: [],
      reset: [],
    });
    // Plain values are filtered afterwards by filterPartialProps; the lazy ones are never computed.
    expect(resolved.props).toEqual({ plain: 1, products_data: "p", memberships_data: "m" });
    expect(resolved.deferredProps).toEqual({});
  });
});
