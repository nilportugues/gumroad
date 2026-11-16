import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  stored: [null, null] as (string | null)[],
  stats: [] as Record<string, number>[],
  enqueued: [] as unknown[][],
}));

vi.mock("../infra/flipper.ts", () => ({
  isFeatureEnabled: () => Promise.resolve(mocks.enabled),
  userActor: (id: string) => ({ id }),
}));
vi.mock("../infra/redis.ts", () => ({ getRedis: () => ({ mget: () => Promise.resolve(mocks.stored) }) }));
vi.mock("./concerns/job-runtime.ts", () => ({
  performAsync: (...args: unknown[]) => {
    mocks.enqueued.push(args);
    return Promise.resolve("jid");
  },
}));
vi.mock("./sql.ts", () => ({
  table: (name: string) => ({ raw: name }),
  column: (tableName: string, name: string) => ({ raw: `${tableName}.${name}` }),
  selectRows: () => Promise.resolve(mocks.stats),
}));

import { sellerReputationProps } from "./user-reputation-summary.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const DISPLAY_PRODUCT_REVIEWS = 1 << 16;
const seller = { id: 7n };
const product = { id: 9n, flags: DISPLAY_PRODUCT_REVIEWS, draft: false, deleted_at: null };
// Three products: 8 fives, 4 fours + 2 threes, and the viewed product's 2 fives + 2 threes.
const snapshot = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ aggregate: [3, 18, 40 + 22 + 16], signature: 5, computed_at: NOW_SECONDS - 60, ...overrides });
const viewedStat = {
  reviews_count: 4,
  ratings_of_five_count: 2,
  ratings_of_four_count: 0,
  ratings_of_three_count: 2,
  ratings_of_two_count: 0,
  ratings_of_one_count: 0,
};

async function props(afterRender: (() => Promise<void>)[] = []) {
  const result = await sellerReputationProps(seller, product, afterRender, NOW);
  for (const effect of afterRender) await effect();
  return result;
}

// User::ReputationSummary#seller_reputation_summary(exclude_product:, snapshot_only: true)
describe("sellerReputationProps", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.stored = [snapshot(), "5"];
    mocks.stats = [viewedStat];
    mocks.enqueued = [];
  });

  it("leaves the key out while the flag is off", async () => {
    mocks.enabled = false;

    expect(await props()).toEqual({});
    expect(mocks.enqueued).toEqual([]);
  });

  it("subtracts the viewed product from a current snapshot and queues no refresh", async () => {
    expect(await props()).toEqual({ seller_reputation: { average: 4.4, count: 14, products_count: 2 } });
    expect(mocks.enqueued).toEqual([]);
  });

  it("queues the refresh of a current snapshot older than ten minutes", async () => {
    mocks.stored = [snapshot({ computed_at: NOW_SECONDS - 601 }), "5"];

    expect(await props()).toEqual({ seller_reputation: { average: 4.4, count: 14, products_count: 2 } });
    expect(mocks.enqueued).toEqual([["WarmSellerReputationSummaryJob", [7]]]);
  });

  it("renders nothing and queues the refresh when the snapshot is behind the version", async () => {
    mocks.stored = [snapshot(), "6"];

    expect(await props()).toEqual({ seller_reputation: null });
    expect(mocks.enqueued).toEqual([["WarmSellerReputationSummaryJob", [7]]]);
  });

  it("reads a missing version as zero", async () => {
    mocks.stored = [snapshot({ signature: 0 }), null];

    expect(await props()).toEqual({ seller_reputation: { average: 4.4, count: 14, products_count: 2 } });
    expect(mocks.enqueued).toEqual([]);
  });

  it("renders nothing and queues the job that builds a missing snapshot", async () => {
    mocks.stored = [null, "5"];

    expect(await props()).toEqual({ seller_reputation: null });
    expect(mocks.enqueued).toEqual([["WarmSellerReputationSummaryJob", [7]]]);
  });

  it("keeps the aggregate whole when the viewed product never counted in it", async () => {
    mocks.stats = [];

    expect(await props()).toEqual({ seller_reputation: { average: 4.3, count: 18, products_count: 3 } });
  });

  it("pushes the job only when the caller runs the collected effects", async () => {
    mocks.stored = [null, null];
    const afterRender: (() => Promise<void>)[] = [];

    await sellerReputationProps(seller, product, afterRender, NOW);

    expect(mocks.enqueued).toEqual([]);
    expect(afterRender).toHaveLength(1);
  });

  it("hands back a snapshot it cannot read", async () => {
    mocks.stored = ["{not json", "5"];

    await expect(props()).rejects.toThrow("unreadable snapshot");
  });
});
