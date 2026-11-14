import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectRows } = vi.hoisted(() => ({ selectRows: vi.fn() }));

vi.mock("./sql.ts", async (original) => ({ ...(await original<typeof import("./sql.ts")>()), selectRows }));

const { preloadProductUpdatesData } = await import("./purchase-product-updates.ts");

// flag_shih_tzu: flag 10 is bit 2**9
const BLOCK_ACCESS_FLAG = 2n ** 9n;
const NOW = new Date("2026-11-10T12:00:00Z");
const PAST = new Date("2026-11-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

const purchase = (extra = {}) => ({ id: 1n, link_id: 10n, seller_id: 20n, subscription_id: null, ...extra });

// What the database holds, answered by the table each statement reads.
function database({
  flags = 0n,
  subscription = undefined as Record<string, unknown> | undefined,
  posts = false,
  productRows = true,
}) {
  selectRows.mockImplementation((query: Prisma.Sql) => {
    if (query.sql.includes("FROM `subscriptions`"))
      return Promise.resolve(
        subscription ? [{ id: 5n, failed_at: null, ended_at: null, cancelled_at: null, ...subscription }] : [],
      );
    if (query.sql.includes("FROM `links`")) return Promise.resolve(productRows ? [{ id: 10n, flags }] : []);
    if (query.sql.includes("FROM `installments`")) return Promise.resolve(posts ? [{ "1": 1 }] : []);
    throw new Error(`unexpected query ${query.sql}`);
  });
}

const readInstallments = () =>
  selectRows.mock.calls.some(([query]) => (query as Prisma.Sql).sql.includes("FROM `installments`"));

beforeEach(() => {
  selectRows.mockReset();
});

describe("preloadProductUpdatesData", () => {
  it("answers nothing for no purchases, without querying", async () => {
    expect((await preloadProductUpdatesData([], NOW)).size).toBe(0);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("answers an empty list for a purchase whose seller and product have no posts", async () => {
    database({});
    expect(await preloadProductUpdatesData([purchase()], NOW)).toEqual(new Map([[1n, []]]));
  });

  it("looks only for posts that are alive and published, since a draft or a deleted post never reaches a buyer", async () => {
    database({});
    await preloadProductUpdatesData([purchase()], NOW);
    const sql = selectRows.mock.calls
      .map(([query]) => (query as Prisma.Sql).sql)
      .find((text) => text.includes("FROM `installments`"));
    expect(sql).toContain("`installments`.`deleted_at` IS NULL");
    expect(sql).toContain("`installments`.`published_at` IS NOT NULL");
  });

  it("hands a purchase over when the seller or product has any post", async () => {
    database({ posts: true });
    await expect(preloadProductUpdatesData([purchase()], NOW)).rejects.toThrow(/product_installments/u);
  });

  it("answers an empty list for a lapsed membership of a product that blocks access, whatever the seller has posted", async () => {
    database({ flags: BLOCK_ACCESS_FLAG, subscription: { ended_at: PAST }, posts: true });
    expect(await preloadProductUpdatesData([purchase({ subscription_id: 5n })], NOW)).toEqual(new Map([[1n, []]]));
    expect(readInstallments()).toBe(false);
  });

  it("treats a failed subscription and a cancellation in the past as not alive", async () => {
    for (const subscription of [{ failed_at: PAST }, { cancelled_at: PAST }]) {
      database({ flags: BLOCK_ACCESS_FLAG, subscription, posts: true });
      expect(await preloadProductUpdatesData([purchase({ subscription_id: 5n })], NOW)).toEqual(new Map([[1n, []]]));
    }
  });

  it("keeps showing posts to a membership that is pending cancellation", async () => {
    database({ flags: BLOCK_ACCESS_FLAG, subscription: { cancelled_at: FUTURE }, posts: true });
    await expect(preloadProductUpdatesData([purchase({ subscription_id: 5n })], NOW)).rejects.toThrow(/not ported/u);
  });

  it("keeps showing posts to a lapsed membership of a product that does not block access", async () => {
    database({ subscription: { ended_at: PAST }, posts: true });
    await expect(preloadProductUpdatesData([purchase({ subscription_id: 5n })], NOW)).rejects.toThrow(/not ported/u);
  });

  it("answers every purchase of a batch, blocked or not", async () => {
    database({ flags: BLOCK_ACCESS_FLAG, subscription: { ended_at: PAST } });
    const result = await preloadProductUpdatesData([purchase({ subscription_id: 5n }), purchase({ id: 2n })], NOW);
    expect(result).toEqual(
      new Map([
        [1n, []],
        [2n, []],
      ]),
    );
  });

  it("hands a purchase over when its product or subscription row is missing", async () => {
    database({ productRows: false });
    await expect(preloadProductUpdatesData([purchase()], NOW)).rejects.toThrow(/product row is missing/u);
    database({});
    await expect(preloadProductUpdatesData([purchase({ subscription_id: 5n })], NOW)).rejects.toThrow(
      /subscription row is missing/u,
    );
  });
});
