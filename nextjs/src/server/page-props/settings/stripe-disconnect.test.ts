import { type Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows,
}));

import { balanceToForfeitCents } from "./payments.ts";
import { activePreorders, activeSubscribers, stripeDisconnectAllowed } from "./stripe-disconnect.ts";

const text = (call: number) => (selectRows.mock.calls[call]![0] as Prisma.Sql).sql;

beforeEach(() => selectRows.mockReset());

describe("stripeDisconnectAllowed", () => {
  it("allows the disconnect when nothing charges through the account", async () => {
    selectRows.mockResolvedValue([]);
    expect(await stripeDisconnectAllowed(7, 9)).toBe(true);
    expect(selectRows).toHaveBeenCalledTimes(4);
  });

  it("refuses when a guest subscription runs on the account, without asking about preorders", async () => {
    selectRows.mockResolvedValueOnce([{ present: 1 }]);
    expect(await stripeDisconnectAllowed(7, 9)).toBe(false);
    expect(selectRows).toHaveBeenCalledTimes(1);
    expect(text(0)).toContain("`subscriptions`.`user_id` IS NULL");
  });

  it("refuses when a signed-in subscriber's subscription runs on the account", async () => {
    selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ present: 1 }]);
    expect(await stripeDisconnectAllowed(7, 9)).toBe(false);
    expect(text(1)).toContain("`subscriptions`.`user_id` IS NOT NULL");
  });

  it("refuses when an authorized preorder is waiting on the account", async () => {
    selectRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ present: 1 }]);
    expect(await stripeDisconnectAllowed(7, 9)).toBe(false);
    expect(text(2)).toContain("`preorders`.`state` = 'authorization_successful'");
    expect(text(2)).toContain("`preorders`.`purchaser_id` IS NULL");
  });

  it("scopes every query to the seller and the Connect account", async () => {
    selectRows.mockResolvedValue([]);
    await stripeDisconnectAllowed(7, 9);
    for (const [sql] of selectRows.mock.calls as [Prisma.Sql][]) {
      expect(sql.values).toEqual(expect.arrayContaining([7, 9, "stripe"]));
    }
  });
});

describe("activeSubscribers and activePreorders for another processor", () => {
  it("filter on the processor and, with no merchant account, not on the account", async () => {
    selectRows.mockResolvedValue([]);
    expect(await activeSubscribers(7, "paypal")).toBe(false);
    expect(await activePreorders(7, "paypal")).toBe(false);
    for (const [sql] of selectRows.mock.calls as [Prisma.Sql][]) {
      expect(sql.values).toEqual(expect.arrayContaining([7, "paypal"]));
      expect(sql.sql).not.toContain("merchant_account_id");
    }
  });
});

describe("balanceToForfeitCents", () => {
  const seller = { id: 7n } as never;

  it("excludes the lowest-id Gumroad account of each processor", async () => {
    selectRows.mockResolvedValueOnce([{ id: 1 }, { id: 4 }]).mockResolvedValueOnce([{ sum: 1250n }]);
    expect(await balanceToForfeitCents(seller)).toBe(1250n);
    expect(text(0)).toContain("MIN(`merchant_accounts`.`id`)");
    expect(text(0)).toContain("GROUP BY `merchant_accounts`.`charge_processor_id`");
    expect(text(1)).toContain("NOT IN (?,?)");
  });

  it("sums to zero without balances", async () => {
    selectRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ sum: null }]);
    expect(await balanceToForfeitCents(seller)).toBe(0n);
  });
});
