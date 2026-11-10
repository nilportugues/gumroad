// spec/models/wishlist_product_spec.rb (recurrence and versioned-product validations) as the wishlist products controller reaches them.
import type { WishlistProduct } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { setAssociation } from "./concerns/rails-validations.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { WishlistProducts } from "./wishlist-follower.ts";

const RECURRING_BILLING = 2n;
const SKUS_ENABLED = 256n;

let db: ReturnType<typeof fakeDatabase>;

function wishlistProduct(attributes: Partial<WishlistProduct> = {}): ModelRecord<WishlistProduct> {
  const record = WishlistProducts.build({ wishlist_id: 1n, product_id: 2n, variant_id: null, recurrence: null, quantity: 1, rent: false, ...attributes } as Partial<WishlistProduct>);
  setAssociation(record, "wishlist", 1n, { id: 1n });
  setAssociation(record, "product", 2n, { id: 2n });
  return record;
}

// One answer per query, in the order they run: the product's flags for the recurrence check, then (without a variant) the flags
// again, the sku count when skus are enabled, the alive versions, and the wishlist's product count on create.
function answer(...results: unknown[][]) {
  db.queueQueryResults(...results);
}

beforeEach(() => {
  db = fakeDatabase();
});

describe("WishlistProduct recurrence", () => {
  it("requires an allowed recurrence for a recurring product", async () => {
    const record = wishlistProduct({ variant_id: 3n });
    answer([{ flags: RECURRING_BILLING }], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Recurrence is not included in the list"]);
  });

  it("accepts a listed recurrence for a recurring product", async () => {
    const record = wishlistProduct({ variant_id: 3n, recurrence: "yearly" });
    answer([{ flags: RECURRING_BILLING }], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(true);
  });

  it("refuses a recurrence for a product that is not recurring", async () => {
    const record = wishlistProduct({ variant_id: 3n, recurrence: "monthly" });
    answer([{ flags: 0n }], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Recurrence must be blank"]);
  });
});

describe("WishlistProduct versioned product", () => {
  it("requires a version when the product has alive versions", async () => {
    const record = wishlistProduct();
    answer([{ flags: 0n }], [{ flags: 0n }], [{ one: 1 }], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Wishlist product must have variant specified for versioned product"]);
  });

  it("requires a version when more than one non-default sku is alive", async () => {
    const record = wishlistProduct();
    answer([{ flags: SKUS_ENABLED }], [{ flags: SKUS_ENABLED }], [{ count: 2n }], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(false);
    expect(record.errors.fullMessages()).toEqual(["Wishlist product must have variant specified for versioned product"]);
  });

  it("accepts a product without versions", async () => {
    const record = wishlistProduct();
    answer([{ flags: 0n }], [{ flags: 0n }], [], [{ count: 0n }]);

    expect(await WishlistProducts.valid(record)).toBe(true);
  });
});
