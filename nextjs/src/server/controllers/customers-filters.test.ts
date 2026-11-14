import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "../../lib/obfuscate-ids.ts";

process.env.OBFUSCATE_IDS_CIPHER_KEY = "customers-filters-test-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY = "12345";

const selectRows = vi.fn();
const isFeatureEnabled = vi.fn();
vi.mock("../models/sql.ts", async (original) => ({ ...(await original<typeof import("../models/sql.ts")>()), selectRows }));
vi.mock("../infra/flipper.ts", () => ({ isFeatureEnabled, userActor: (id: unknown) => ({ id }) }));

const { createdWindow, customersSalesFilters, readFilterParams } = await import("./customers-filters.ts");
const { HandBackToRails } = await import("./application-controller.ts");

const seller = { id: 1n, currency_type: "usd", timezone: "Pacific Time (US & Canada)" } as never;
const filters = (params: Record<string, unknown>) => readFilterParams(params);

beforeEach(() => {
  selectRows.mockReset();
  isFeatureEnabled.mockReset();
});

describe("readFilterParams", () => {
  it("wraps a scalar into a list and reads absent keys as empty", () => {
    expect(filters({ products: "abc" })).toMatchObject({ products: ["abc"], variants: [], excludedProducts: [], activeCustomersOnly: false });
    expect(filters({ variants: ["a", "b"] }).variants).toEqual(["a", "b"]);
  });

  it("casts active_customers_only like ActiveModel::Type::Boolean", () => {
    expect([filters({ active_customers_only: "true" }), filters({ active_customers_only: "false" }), filters({ active_customers_only: "" })].map((f) => f.activeCustomersOnly)).toEqual([true, false, false]);
  });

  it("hands back shapes Rails would read differently", () => {
    expect(() => filters({ products: { 0: "a" } })).toThrow(HandBackToRails);
    expect(() => filters({ products: [null] })).toThrow(HandBackToRails);
    expect(() => filters({ country: ["France"] })).toThrow(HandBackToRails);
    expect(() => filters({ minimum_amount_cents: null })).toThrow(HandBackToRails);
  });
});

describe("createdWindow", () => {
  it("reads a date as midnight in the seller's zone and the end date through the end of that day", () => {
    const window = createdWindow(seller, "2025-01-10", "2025-01-12");
    expect(window.created_on_or_after?.toISOString()).toBe("2025-01-10T08:00:00.000Z");
    expect(window.created_before?.toISOString()).toBe("2025-01-13T08:00:00.000Z");
  });

  it("reads an ISO instant as given and adds a day to the end", () => {
    const window = createdWindow(seller, "2025-01-10T08:00:00.000Z", "2025-01-12T08:00:00.000Z");
    expect(window.created_on_or_after?.toISOString()).toBe("2025-01-10T08:00:00.000Z");
    expect(window.created_before?.toISOString()).toBe("2025-01-13T08:00:00.000Z");
  });

  it("serves either bound alone", () => {
    expect(Object.keys(createdWindow(seller, "2025-01-10", undefined))).toEqual(["created_on_or_after"]);
    expect(Object.keys(createdWindow(seller, undefined, "2025-01-10"))).toEqual(["created_before"]);
    expect(createdWindow(seller, undefined, undefined)).toEqual({});
  });

  it("drops a window that ends before it starts", () => {
    expect(createdWindow(seller, "2025-03-01", "2025-01-01")).toEqual({});
    expect(Object.keys(createdWindow(seller, "2025-01-02", "2025-01-01"))).toEqual(["created_on_or_after", "created_before"]);
  });

  it("hands back dates it does not read the way Rails does", () => {
    for (const value of ["", "01/10/2025", "yesterday", "2025-02-30"]) expect(() => createdWindow(seller, value, undefined)).toThrow(HandBackToRails);
  });

  it("hands back an unknown time zone and a day that crosses a DST change", () => {
    expect(() => createdWindow({ timezone: "Nowhere" }, "2025-01-10", undefined)).toThrow(HandBackToRails);
    expect(() => createdWindow(seller, undefined, "2025-03-09T08:00:00.000Z")).toThrow(HandBackToRails);
  });
});

describe("customersSalesFilters", () => {
  it("keeps only the products and variants that exist, and excludes by the others", async () => {
    selectRows.mockResolvedValueOnce([{ id: 7n }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 9n }]).mockResolvedValueOnce([]);
    const options = await customersSalesFilters(seller, filters({ products: [encrypt(7)], variants: [encrypt(8)], excluded_products: encrypt(9), excluded_variants: "garbage" }));
    expect(options.any_products_or_variants).toEqual({ products: [{ id: 7 }] });
    expect(options.exclude_purchasers_of_product).toEqual([{ id: 9 }]);
    expect(options.exclude_purchasers_of_variant).toEqual([]);
  });

  it("adds the active-customer exclusions", async () => {
    const options = await customersSalesFilters(seller, filters({ active_customers_only: "1" }));
    expect(options).toMatchObject({ exclude_deactivated_subscriptions: true, exclude_cancelled_or_pending_cancellation_subscriptions: true, exclude_refunded_except_subscriptions: true, exclude_unreversed_chargedback: true });
  });

  it("reads amounts in USD cents and skips blank ones", async () => {
    const options = await customersSalesFilters(seller, filters({ minimum_amount_cents: "500", maximum_amount_cents: " " }));
    expect(options.price_greater_than).toBe(500);
    expect("price_less_than" in options).toBe(false);
    await expect(customersSalesFilters(seller, filters({ maximum_amount_cents: "1e3" }))).rejects.toThrow(HandBackToRails);
  });

  it("passes a decimal amount of a seller paid in dollars as given and hands back one of another currency", async () => {
    const options = await customersSalesFilters(seller, filters({ minimum_amount_cents: "1399.5", maximum_amount_cents: "1400.5" }));
    expect(options).toMatchObject({ price_greater_than: 1399.5, price_less_than: 1400.5 });
    const euros = { id: 1n, currency_type: "eur", timezone: "Pacific Time (US & Canada)" } as never;
    await expect(customersSalesFilters(euros, filters({ minimum_amount_cents: "10.5" }))).rejects.toThrow(HandBackToRails);
  });

  it("applies minimum_license_uses only while the feature is on", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect("license_uses_greater_than_or_equal_to" in (await customersSalesFilters(seller, filters({ minimum_license_uses: "3" })))).toBe(false);
    expect((await customersSalesFilters(seller, filters({ minimum_license_uses: "3abc" }))).license_uses_greater_than_or_equal_to).toBe(3);
  });
});
