import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
vi.mock("../../models/sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/sql.ts")>()),
  selectRows,
}));

import {
  emptyBalanceDestinationSeasoned,
  seasonedForInstantPayouts,
  type SeasoningRow,
} from "./instant-payout-eligibility.ts";

// User::MIN_ACCOUNT_AGE_FOR_INSTANT_PAYOUTS is 60 days.
const NOW = new Date("2026-06-15T12:00:00Z");
const OLD = new Date("2026-01-01T00:00:00Z");
const RECENT = new Date("2026-06-01T00:00:00Z");

const account = (attributes: Partial<SeasoningRow> & { connect?: boolean } = {}): SeasoningRow => {
  const { connect, ...rest } = attributes;
  return {
    id: 1,
    user_id: 7,
    charge_processor_id: "stripe",
    charge_processor_merchant_id: "acct_1",
    country: "US",
    json_data: connect ? '{"meta":{"stripe_connect":"true"}}' : null,
    created_at: RECENT,
    charge_processor_alive_at: RECENT,
    charge_processor_deleted_at: null,
    ...rest,
  };
};

describe("seasonedForInstantPayouts", () => {
  it("seasons an account older than 60 days by its own age", () => {
    expect(seasonedForInstantPayouts(account({ created_at: OLD }), [], NOW)).toBe(true);
  });

  it("does not season a new account with no predecessor", () => {
    expect(seasonedForInstantPayouts(account(), [account()], NOW)).toBe(false);
  });

  it("inherits seasoning from an older retired account of the same kind", () => {
    const retired = account({ id: 2, created_at: OLD, charge_processor_deleted_at: RECENT });
    expect(seasonedForInstantPayouts(account(), [retired], NOW)).toBe(true);
  });

  it("does not inherit from a predecessor of the other kind", () => {
    expect(seasonedForInstantPayouts(account(), [account({ id: 2, created_at: OLD, connect: true })], NOW)).toBe(false);
    expect(seasonedForInstantPayouts(account({ connect: true }), [account({ id: 2, created_at: OLD })], NOW)).toBe(
      false,
    );
  });

  it("does not inherit from a rejected predecessor", () => {
    const rejected = account({ id: 2, created_at: OLD, json_data: '{"stripe_disabled_reason":"rejected.fraud"}' });
    expect(seasonedForInstantPayouts(account(), [rejected], NOW)).toBe(false);
  });

  it("does not inherit from a predecessor that never processed anything", () => {
    const failed = account({
      id: 2,
      created_at: OLD,
      charge_processor_alive_at: null,
      charge_processor_deleted_at: null,
    });
    expect(seasonedForInstantPayouts(account(), [failed], NOW)).toBe(false);
  });

  it("does not inherit from a predecessor that is itself under 60 days old", () => {
    expect(
      seasonedForInstantPayouts(account(), [account({ id: 2, created_at: new Date("2026-05-01T00:00:00Z") })], NOW),
    ).toBe(false);
  });
});

describe("emptyBalanceDestinationSeasoned", () => {
  beforeEach(() => selectRows.mockReset());

  it("is false without a destination, because the seller is not eligible", async () => {
    expect(
      await emptyBalanceDestinationSeasoned(
        7n,
        { connectRoutingActive: false, connect: account({ connect: true }), standard: null },
        NOW,
      ),
    ).toBe(false);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("picks the Connect account when the seller routes through Stripe Connect, the standard one otherwise", async () => {
    selectRows.mockResolvedValue([]);
    const connect = account({ id: 1, connect: true, created_at: OLD });
    const standard = account({ id: 2 });
    expect(await emptyBalanceDestinationSeasoned(7n, { connectRoutingActive: true, connect, standard }, NOW)).toBe(
      true,
    );
    expect(await emptyBalanceDestinationSeasoned(7n, { connectRoutingActive: false, connect, standard }, NOW)).toBe(
      false,
    );
  });

  it("is true when the destination is seasoned", async () => {
    selectRows.mockResolvedValue([]);
    expect(
      await emptyBalanceDestinationSeasoned(
        7n,
        { connectRoutingActive: false, connect: null, standard: account({ created_at: OLD }) },
        NOW,
      ),
    ).toBe(true);
  });

  it("counts the seller's retired Stripe accounts as predecessors", async () => {
    const standard = account({ id: 2 });
    selectRows.mockResolvedValue([standard, account({ id: 1, created_at: OLD, charge_processor_deleted_at: RECENT })]);
    expect(
      await emptyBalanceDestinationSeasoned(7n, { connectRoutingActive: false, connect: null, standard }, NOW),
    ).toBe(true);
  });
});
