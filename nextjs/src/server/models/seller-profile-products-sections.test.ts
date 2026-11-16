import { beforeEach, describe, expect, it } from "vitest";

import { assertProfileSectionsEditable, clearFeaturedProductSections, removeFromProfileSections } from "./seller-profile-products-sections.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { transaction } from "./runtime/transaction.ts";
import { NotPortedError } from "./user.ts";

let db: ReturnType<typeof fakeDatabase>;
beforeEach(() => {
  db = fakeDatabase();
});

const SELLER = { id: 5n };
const NOW = () => new Date("2025-03-01T10:00:00Z");
const PRODUCTS_DATA = { default_product_sort: "page_layout", shown_products: [7, 9, 11], show_filters: true, add_new_products: false };
const section = (id: number, type: string, json_data: unknown) => ({
  id: BigInt(id),
  seller_id: 5n,
  header: null,
  created_at: NOW(),
  updated_at: new Date("2025-01-01T00:00:00Z"),
  flags: 0n,
  json_data,
  type,
  product_id: null,
});
const productsSection = (id: number, data: Record<string, unknown> = PRODUCTS_DATA) => section(id, "SellerProfileProductsSection", data);
const featuredSection = (id: number, data: Record<string, unknown> = { featured_product_id: 9 }) => section(id, "SellerProfileFeaturedProductSection", data);
const run = <T>(fn: () => Promise<T>) => transaction(async () => fn());

describe("removeFromProfileSections", () => {
  it("strips the product from the sections that show it and leaves the others untouched", async () => {
    // no seller profile, then the seller's products sections
    db.queueQueryResults([], [productsSection(1), productsSection(2, { ...PRODUCTS_DATA, shown_products: [7] })], [SELLER]);
    await run(() => removeFromProfileSections(5n, 9n, NOW));

    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ model: "sellerProfileSection", op: "update", id: 1n });
    expect(db.writes[0]!.data).toMatchObject({ json_data: { ...PRODUCTS_DATA, shown_products: [7, 11] }, updated_at: NOW() });
  });

  it("reads the products sections of the seller, per-product ones included", async () => {
    db.queueQueryResults([], []);
    await run(() => removeFromProfileSections(5n, 9n, NOW));
    expect(db.queries.map((query) => query.sql)).toEqual([
      "SELECT `seller_profiles`.* FROM `seller_profiles` WHERE `seller_profiles`.`seller_id` = ? LIMIT 1",
      "SELECT `seller_profile_sections`.* FROM `seller_profile_sections` WHERE `seller_profile_sections`.`type` = ? AND `seller_profile_sections`.`seller_id` = ? ORDER BY `seller_profile_sections`.`id`",
    ]);
    expect(db.queries[1]!.values).toEqual(["SellerProfileProductsSection", 5n]);
  });

  it("locks the seller profile row before editing the sections when the seller has one", async () => {
    db.queueQueryResults([{ id: 3n, seller_id: 5n }], [{ id: 3n }], [productsSection(1)], [SELLER]);
    await run(() => removeFromProfileSections(5n, 9n, NOW));
    expect(db.queries[1]!.sql).toBe("SELECT `seller_profiles`.* FROM `seller_profiles` WHERE `seller_profiles`.`seller_id` = ? LIMIT 1 FOR UPDATE");
    expect(db.writes).toHaveLength(1);
  });

  it("reads a json_data returned as text", async () => {
    db.queueQueryResults([], [productsSection(1, JSON.stringify(PRODUCTS_DATA) as never)], [SELLER]);
    await run(() => removeFromProfileSections(5n, 9n, NOW));
    expect(db.writes[0]!.data).toMatchObject({ json_data: { ...PRODUCTS_DATA, shown_products: [7, 11] } });
  });
});

describe("clearFeaturedProductSections", () => {
  it("drops featured_product_id from the sections featuring the product", async () => {
    db.queueQueryResults([featuredSection(4)], [SELLER]);
    await run(() => clearFeaturedProductSections(5n, 9n, NOW));

    expect(db.queries[0]!.sql).toContain('CAST(JSON_EXTRACT(`seller_profile_sections`.`json_data`, "$.featured_product_id") AS UNSIGNED) = ?');
    expect(db.queries[0]!.values).toEqual(["SellerProfileFeaturedProductSection", 5n, 9n]);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ op: "update", id: 4n, data: { json_data: {}, updated_at: NOW() } });
  });

  it("writes nothing when no section features the product", async () => {
    db.queueQueryResults([]);
    await run(() => clearFeaturedProductSections(5n, 9n, NOW));
    expect(db.writes).toEqual([]);
  });
});

describe("assertProfileSectionsEditable", () => {
  it("passes when the edited sections stay valid", async () => {
    db.queueQueryResults([featuredSection(4)], [productsSection(1), productsSection(2, { ...PRODUCTS_DATA, shown_products: [7] })]);
    await expect(run(() => assertProfileSectionsEditable(5n, 9n))).resolves.toBeUndefined();
    expect(db.writes).toEqual([]);
  });

  it("refuses a products section showing the product whose json_data would not pass the schema", async () => {
    db.queueQueryResults([], [productsSection(1, { shown_products: [9] })]);
    await expect(run(() => assertProfileSectionsEditable(5n, 9n))).rejects.toThrow(NotPortedError);
  });

  it("ignores a broken products section that does not show the product", async () => {
    db.queueQueryResults([], [productsSection(1, { shown_products: [7] })]);
    await expect(run(() => assertProfileSectionsEditable(5n, 9n))).resolves.toBeUndefined();
  });

  it("refuses a featured-product section with a key the schema does not allow", async () => {
    db.queueQueryResults([featuredSection(4, { featured_product_id: 9, header: "x" })]);
    await expect(run(() => assertProfileSectionsEditable(5n, 9n))).rejects.toThrow(NotPortedError);
  });
});
