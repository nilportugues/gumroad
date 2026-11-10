import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows,
}));
vi.mock("../../../lib/db.ts", () => ({ db: {} }));

import { hasCuratedProductSources } from "./discover.ts";

const visitor = { id: 7n, flags: 0n, currency_type: "usd" };
const sqlOf = (query: Prisma.Sql) => query.strings.join("?");
const text = (call: number) => sqlOf(selectRows.mock.calls[call]![0] as Prisma.Sql);

// Answers each query by the table it reads.
function database(rows: { cart?: bigint; cartProducts?: boolean; purchases?: boolean }) {
  selectRows.mockImplementation(async (query: Prisma.Sql) => {
    const sql = sqlOf(query);
    if (sql.includes("FROM `carts`")) return rows.cart === undefined ? [] : [{ id: rows.cart }];
    if (sql.includes("FROM `cart_products`")) return rows.cartProducts ? [{ 1: 1 }] : [];
    return rows.purchases ? [{ 1: 1 }] : [];
  });
}

beforeEach(() => {
  selectRows.mockReset();
});

describe("hasCuratedProductSources", () => {
  it("is false for a visitor with no cart and no purchases", async () => {
    database({});
    expect(await hasCuratedProductSources(visitor, null)).toBe(false);
  });

  it("is false when the cart holds only deleted products and there are no purchases", async () => {
    database({ cart: 3n, cartProducts: false });
    expect(await hasCuratedProductSources(visitor, null)).toBe(false);
    expect(text(1)).toContain("`cart_products`.`deleted_at` IS NULL");
  });

  it("is true when the first alive cart has an alive product", async () => {
    database({ cart: 3n, cartProducts: true });
    expect(await hasCuratedProductSources(visitor, null)).toBe(true);
    expect(text(0)).toContain("ORDER BY `carts`.`id` ASC LIMIT 1");
  });

  it("is true for a purchase and reads only purchases that join a product", async () => {
    database({ purchases: true });
    expect(await hasCuratedProductSources(visitor, null)).toBe(true);
    expect(text(1)).toContain("INNER JOIN `links`");
  });

  it("looks up the guest cart by guid for an anonymous visitor and never reads purchases", async () => {
    database({ cart: 4n, cartProducts: false, purchases: true });
    expect(await hasCuratedProductSources(null, "guid")).toBe(false);
    expect(text(0)).toContain("`carts`.`user_id` IS NULL");
    expect(selectRows).toHaveBeenCalledTimes(2);
  });

  it("is true for an anonymous visitor whose guest cart has a product, and false without a guid", async () => {
    database({ cart: 4n, cartProducts: true });
    expect(await hasCuratedProductSources(null, "guid")).toBe(true);
    selectRows.mockClear();
    expect(await hasCuratedProductSources(null, null)).toBe(false);
    expect(selectRows).not.toHaveBeenCalled();
  });
});
