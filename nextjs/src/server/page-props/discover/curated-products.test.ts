import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  links: new Map<bigint, Record<string, unknown>>(),
  users: new Map<bigint, Record<string, unknown>>(),
  limit: null as string | null,
}));

vi.mock("../../presenters/product-reads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../presenters/product-reads.ts")>()),
  findLink: async (id: bigint) => mocks.links.get(id) ?? null,
  findUserById: async (id: bigint) => mocks.users.get(id) ?? null,
}));
vi.mock("../../presenters/product.ts", () => ({ effectiveUsername: (user: { username: string }) => user.username }));
vi.mock("../../infra/redis.ts", () => ({ getRedis: () => ({ get: async () => mocks.limit }) }));

import { renderSql } from "../../models/runtime/quoting.ts";
import { setSqlClient } from "../../models/sql.ts";
import { NotPortedError } from "../not-ported.ts";

import { associatedProductIds, curatedProducts, curatedTaxonomyIds, relatedProductIds } from "./curated-products.ts";

const visitor = { id: 7n };
const sent: string[] = [];
let rows: {
  cart?: bigint;
  cartProducts?: bigint[];
  purchased?: bigint[];
  counts?: Record<string, unknown>;
  bundled?: bigint[];
} = {};

// Answers each query by the table it reads.
function database() {
  setSqlClient(() => ({
    $queryRaw: (async (query: Prisma.Sql) => {
      const sql = renderSql(query);
      sent.push(sql);
      if (sql.includes("FROM `carts`")) return rows.cart === undefined ? [] : [{ id: rows.cart }];
      if (sql.includes("FROM `cart_products`")) return (rows.cartProducts ?? []).map((product_id) => ({ product_id }));
      if (sql.includes("FROM `links` INNER JOIN `purchases`")) return (rows.purchased ?? []).map((id) => ({ id }));
      if (sql.includes("FROM `cached_sales_related_products_infos`"))
        return Object.entries(rows.counts ?? {}).map(([, counts]) => ({ counts }));
      if (sql.includes("FROM `bundle_products`")) return (rows.bundled ?? []).map((product_id) => ({ product_id }));
      return [];
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
}

// The flag bits a product row carries: archived is flag 5 and is_adult flag 16.
const ARCHIVED = 1n << 4n;
const ADULT = 1n << 15n;
const product = (id: bigint, overrides: Record<string, unknown> = {}) => {
  mocks.links.set(id, {
    id,
    user_id: 1n,
    name: `Product ${id}`,
    description: "A product",
    flags: 0n,
    deleted_at: null,
    banned_at: null,
    purchase_disabled_at: null,
    taxonomy_id: 3n,
    ...overrides,
  });
};

beforeEach(() => {
  sent.length = 0;
  rows = {};
  mocks.links.clear();
  mocks.users.clear();
  mocks.limit = null;
  mocks.users.set(1n, { id: 1n, flags: 0n, name: "Mara", username: "mara", bio: "Maker" });
  database();
});

describe("associatedProductIds", () => {
  it("is empty for a visitor with neither a cart nor purchases", async () => {
    expect(await associatedProductIds(visitor, null)).toEqual([]);
  });

  it("reads the lowest alive cart of a signed-in visitor and its alive products", async () => {
    rows = { cart: 3n, cartProducts: [10n] };
    expect(await associatedProductIds(visitor, "guid")).toEqual([10n]);
    expect(sent[0]).toContain(
      "`carts`.`user_id` = 7 AND `carts`.`deleted_at` IS NULL ORDER BY `carts`.`id` ASC LIMIT 1",
    );
    expect(sent[1]).toContain("`cart_products`.`deleted_at` IS NULL");
  });

  it("reads the guest cart of the guid for an anonymous visitor and never reads purchases", async () => {
    rows = { cart: 4n, cartProducts: [10n], purchased: [11n] };
    expect(await associatedProductIds(null, "guid")).toEqual([10n]);
    expect(sent[0]).toContain("`carts`.`browser_guid` = 'guid' AND `carts`.`user_id` IS NULL");
    expect(sent.some((sql) => sql.includes("`purchases`"))).toBe(false);
  });

  it("reads nothing for an anonymous visitor without a guid", async () => {
    expect(await associatedProductIds(null, null)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("counts a product that is in the cart and was purchased once", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n], purchased: [10n, 12n] };
    expect(await associatedProductIds(visitor, null)).toEqual([10n, 11n, 12n]);
  });

  it("joins links for the purchased products, as purchased_products does", async () => {
    rows = { purchased: [10n] };
    await associatedProductIds(visitor, null);
    expect(sent.at(-1)).toContain("SELECT DISTINCT `links`.`id` FROM `links` INNER JOIN `purchases`");
  });

  it("hands back 4 associated ids when one has a cached related-products row, because Rails samples them at random", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n], purchased: [12n, 13n], counts: { "10": { "20": 1 } } };
    await expect(associatedProductIds(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("answers nothing for 4 associated ids none of which has a cached related-products row", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n], purchased: [12n, 13n] };
    expect(await associatedProductIds(visitor, null)).toEqual([]);
  });

  it("hands back 4 associated ids when the associated ids limit is set", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n], purchased: [12n, 13n] };
    mocks.limit = "1";
    await expect(associatedProductIds(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("hands back 4 associated ids when a side may have more than the default limit", async () => {
    rows = { cart: 3n, cartProducts: Array.from({ length: 100 }, (_, i) => BigInt(i + 10)) };
    await expect(associatedProductIds(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("does not hand back 4 rows that are only 3 distinct ids", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n, 12n], purchased: [10n] };
    expect(await associatedProductIds(visitor, null)).toEqual([10n, 11n, 12n]);
  });

  it("hands back when the associated ids limit is set, because it makes the order of the seeds matter", async () => {
    rows = { purchased: [10n] };
    mocks.limit = "1";
    await expect(associatedProductIds(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("reads no limit when there are no seeds", async () => {
    mocks.limit = "1";
    expect(await associatedProductIds(visitor, null)).toEqual([]);
  });
});

describe("relatedProductIds", () => {
  it("sums the counts of every associated product and leaves the associated ones out", async () => {
    rows = { counts: { a: { "20": 2, "21": 1, "10": 9 }, b: { "20": 3, "22": 4, "11": 9 } } };
    expect(await relatedProductIds([10n, 11n], 40)).toEqual([20n, 22n, 21n]);
  });

  it("puts the higher product id first among equal counts", async () => {
    rows = { counts: { a: { "20": 2, "30": 2, "25": 2 } } };
    expect(await relatedProductIds([10n], 40)).toEqual([30n, 25n, 20n]);
  });

  it("cuts the list at the limit", async () => {
    rows = { counts: { a: { "20": 3, "21": 2, "22": 1 } } };
    expect(await relatedProductIds([10n], 2)).toEqual([20n, 21n]);
  });

  it("is empty without seeds, reading nothing", async () => {
    expect(await relatedProductIds([], 40)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("treats a product with no cached row, or a null counts column, as having no related products", async () => {
    expect(await relatedProductIds([10n], 40)).toEqual([]);
    rows = { counts: { a: null as never } };
    expect(await relatedProductIds([10n], 40)).toEqual([]);
  });

  it("reads counts that arrive as a JSON string", async () => {
    rows = { counts: { a: '{"20": 1}' as never } };
    expect(await relatedProductIds([10n], 40)).toEqual([20n]);
  });

  it("hands back counts that are not a map of integers", async () => {
    rows = { counts: { a: { "20": 1.5 } } };
    await expect(relatedProductIds([10n], 40)).rejects.toBeInstanceOf(NotPortedError);
    rows = { counts: { a: { twenty: 1 } } };
    await expect(relatedProductIds([10n], 40)).rejects.toBeInstanceOf(NotPortedError);
    rows = { counts: { a: [1] as never } };
    await expect(relatedProductIds([10n], 40)).rejects.toBeInstanceOf(NotPortedError);
  });
});

describe("curatedProducts", () => {
  const ids = async () => (await curatedProducts(visitor, null)).map((row) => row.id);

  beforeEach(() => {
    rows = { purchased: [10n], counts: { a: { "20": 5, "21": 4, "22": 3, "23": 2 } } };
    for (const id of [20n, 21n, 22n, 23n]) product(id);
  });

  it("returns the related products in order", async () => {
    expect(await ids()).toEqual([20n, 21n, 22n, 23n]);
  });

  it("is empty when no product is related", async () => {
    rows = { purchased: [10n] };
    expect(await ids()).toEqual([]);
  });

  it("drops a deleted, banned or purchase-disabled product, and one whose row is gone", async () => {
    product(20n, { deleted_at: new Date() });
    product(21n, { banned_at: new Date() });
    product(22n, { purchase_disabled_at: new Date() });
    mocks.links.delete(23n);
    expect(await ids()).toEqual([]);
  });

  it("drops an archived product", async () => {
    product(21n, { flags: ARCHIVED });
    expect(await ids()).toEqual([20n, 22n, 23n]);
  });

  it("drops a product rated as adult by its flag, its keywords or its seller", async () => {
    product(20n, { flags: ADULT });
    product(21n, { name: "Lingerie lookbook" });
    product(22n, { user_id: 2n });
    mocks.users.set(2n, { id: 2n, flags: 1n << 31n, name: "Pat", username: "pat", bio: null });
    expect(await ids()).toEqual([23n]);
  });

  it("drops a product whose seller name, username or bio has an adult keyword", async () => {
    mocks.users.set(1n, { id: 1n, flags: 0n, name: "Mara", username: "mara", bio: "NSFW art" });
    expect(await ids()).toEqual([]);
  });

  it("hands back a product without a seller, which Ruby raises on", async () => {
    product(20n, { user_id: 9n });
    await expect(curatedProducts(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });

  it("leaves out the products of a bundle the visitor purchased", async () => {
    rows.bundled = [21n];
    expect(await ids()).toEqual([20n, 22n, 23n]);
    expect(sent.find((sql) => sql.includes("`bundle_products`"))).toContain("`bundle_products`.`deleted_at` IS NULL");
  });

  it("cuts the related list at 40 before the filters, so dropped products are not replaced", async () => {
    const counts: Record<string, number> = {};
    for (let id = 100; id < 160; id++) {
      counts[String(id)] = 1000 - id;
      product(BigInt(id), id < 105 ? { deleted_at: new Date() } : {});
    }
    rows.counts = { a: counts };
    expect(await ids()).toEqual(Array.from({ length: 35 }, (_, index) => BigInt(105 + index)));
  });
});

describe("curatedTaxonomyIds", () => {
  it("lists the taxonomy of each curated product in curated order and skips products without one", async () => {
    rows = { cart: 3n, cartProducts: [10n], counts: { a: { "20": 3, "21": 2, "22": 1 } } };
    product(20n, { taxonomy_id: 5n });
    product(21n, { taxonomy_id: null });
    product(22n, { taxonomy_id: 4n });
    expect(await curatedTaxonomyIds(visitor, null)).toEqual([5n, 4n]);
  });

  it("is empty for a visitor with no seeds", async () => {
    expect(await curatedTaxonomyIds(visitor, null)).toEqual([]);
  });

  it("hands back a visitor seeded by 4 ids, so the page that asks for the navigation reaches Rails", async () => {
    rows = { cart: 3n, cartProducts: [10n, 11n], purchased: [12n, 13n], counts: { "10": { "20": 1 } } };
    await expect(curatedTaxonomyIds(visitor, null)).rejects.toBeInstanceOf(NotPortedError);
  });
});
