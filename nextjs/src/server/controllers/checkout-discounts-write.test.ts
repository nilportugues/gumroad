// Vectors are the reads of Checkout::DiscountsController#clean_params and #offer_code_params; the rows each write leaves are pinned by
// the Rails recordings replayed in parity/__tests__/checkout-write-guards.replay.test.ts.
import { describe, expect, it } from "vitest";

import { NotPortedError } from "../page-props/not-ported.ts";

import { readAttributes } from "./checkout-discounts-write.ts";

describe("readAttributes", () => {
  it("nils the currency of a request that names none, as clean_params does", () => {
    expect(readAttributes({ name: "Renamed" }).attributes).toEqual({ name: "Renamed", currency_type: null });
  });

  it("treats a blank currency as none", () => {
    expect(readAttributes({ currency_type: "  ", amount_cents: 200 }).attributes).toEqual({
      currency_type: null,
      amount_cents: 200,
      amount_percentage: null,
    });
  });

  it("clears the cents, the currency and the per-cart flag when a percentage is present", () => {
    const read = readAttributes({
      amount_percentage: 30,
      amount_cents: 200,
      currency_type: "usd",
      once_per_cart: true,
    });
    expect(read.attributes).toEqual({ amount_percentage: 30, amount_cents: null, currency_type: null });
    expect(read.oncePerCart).toBe(false);
  });

  it("clears the percentage when only cents are sent", () => {
    expect(readAttributes({ amount_cents: "300", currency_type: "usd" }).attributes).toEqual({
      amount_cents: 300,
      amount_percentage: null,
      currency_type: "usd",
    });
  });

  it("reads a blank percentage as no percentage", () => {
    expect(readAttributes({ amount_percentage: "", amount_cents: 100 }).attributes).toMatchObject({
      amount_percentage: null,
      amount_cents: 100,
    });
  });

  it("reads a zero percentage as present", () => {
    expect(readAttributes({ amount_percentage: 0, amount_cents: 100 }).attributes).toMatchObject({
      amount_percentage: 0,
      amount_cents: null,
    });
  });

  it("reads the dashboard's empty lists and nulls as nothing to save", () => {
    const read = readAttributes({
      selected_option_ids: [],
      excluded_product_ids: [],
      ownership_product_ids: [],
      ownership_duration_tiers: null,
      duration_in_billing_cycles: null,
      existing_customers_only: false,
      new_customers_only: false,
      once_per_cart: false,
    });
    expect(read.attributes).toEqual({ currency_type: null });
    expect(read.oncePerCart).toBe(false);
  });

  it("reads whole-second timestamps in their offset", () => {
    const { attributes } = readAttributes({
      valid_at: "2030-01-01T10:00:00.000Z",
      expires_at: "2030-01-01T10:00:00+02:00",
    });
    expect(attributes.valid_at).toEqual(new Date("2030-01-01T10:00:00Z"));
    expect(attributes.expires_at).toEqual(new Date("2030-01-01T08:00:00Z"));
  });

  it("reads a blank timestamp as none", () => {
    expect(readAttributes({ valid_at: "", expires_at: null }).attributes).toMatchObject({
      valid_at: null,
      expires_at: null,
    });
  });

  it("casts the booleans the form sends", () => {
    expect(readAttributes({ auto_apply: "true", universal: false }).attributes).toMatchObject({
      auto_apply: true,
      universal: false,
    });
    expect(readAttributes({ auto_apply: null }).attributes).toMatchObject({ auto_apply: null });
  });

  it.each([
    ["a fractional second", { valid_at: "2030-01-01T10:00:00.5Z" }],
    ["a time without seconds", { valid_at: "2030-01-01T10:00" }],
    ["an impossible day", { valid_at: "2030-02-30T10:00:00Z" }],
    ["a timestamp that is a number", { valid_at: 1 }],
    ["a duration in billing cycles", { duration_in_billing_cycles: 3 }],
    ["a code for existing customers", { existing_customers_only: true }],
    ["a code for new customers", { new_customers_only: "true" }],
    ["a code applied once per cart", { once_per_cart: true, amount_cents: 100 }],
    ["duration tiers", { ownership_duration_tiers: [] }],
    ["options to limit the code to", { selected_option_ids: ["abc"] }],
    ["excluded products", { excluded_product_ids: ["abc"] }],
    ["ownership products", { ownership_product_ids: ["abc"] }],
    ["a page of the list", { page: 2 }],
    ["a search of the list", { query: "sale" }],
    ["a sort of the list", { sort: "asc" }],
    ["a fractional amount", { amount_percentage: 12.5 }],
    ["an amount that is a boolean", { amount_cents: true }],
    ["a hash for a scalar", { name: { a: 1 } }],
    ["a name that is a number", { name: 5 }],
    ["a code longer than its column", { code: "a".repeat(256) }],
    ["a universal flag that is null", { universal: null }],
    ["a per-cart flag that is null", { once_per_cart: null }],
    ["an amount outside the column", { max_purchase_count: 2 ** 31 }],
  ])("hands back %s", (_what, params) => {
    expect(() => readAttributes(params)).toThrow(NotPortedError);
  });
});
