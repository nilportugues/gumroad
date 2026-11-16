// Vectors are the reads of Checkout::DiscountsController#fetch_offer_codes: `column` + `sort` become a sort hash, `paged_params` keeps scalars.
import { describe, expect, it } from "vitest";

import { HandBackToRails } from "./application-controller.ts";
import { listingParams } from "./checkout-discounts.ts";

describe("listingParams", () => {
  it("reads page, query and the sort hash", () => {
    expect(listingParams({ page: "3", query: "sale", sort: { key: "uses", direction: "desc" } })).toEqual({
      page: 3,
      query: "sale",
      sort: { key: "uses", direction: "desc" },
    });
  });

  it("defaults a missing page to 0 and a blank query to null", () => {
    expect(listingParams({ query: "  " })).toEqual({ page: 0, query: null, sort: {} });
  });

  it("maps the legacy column and sort params to a sort hash", () => {
    expect(listingParams({ column: "name", sort: "asc" }).sort).toEqual({ key: "name", direction: "asc" });
  });

  it("ignores a sort string when no column is given", () => {
    expect(listingParams({ sort: "asc" }).sort).toEqual({});
  });

  it("hands back an array query", () => {
    expect(() => listingParams({ query: ["a"] })).toThrow(HandBackToRails);
  });

  it("hands back a sort key that is not text", () => {
    expect(() => listingParams({ sort: { key: ["name"] } })).toThrow(HandBackToRails);
  });
});
