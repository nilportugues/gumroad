import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: true, rows: [] as unknown[][], queries: [] as string[] }));

vi.mock("../infra/flipper.ts", () => ({
  isFeatureEnabled: async () => mocks.enabled,
  userActor: (id: string) => ({ id }),
}));
vi.mock("./sql.ts", () => ({
  table: (name: string) => ({ raw: name }),
  column: (tableName: string, name: string) => ({ raw: `${tableName}.${name}` }),
  selectRows: async (sql: { sql: string }) => {
    mocks.queries.push(sql.sql);
    return mocks.rows;
  },
}));

import { buildReputationSummary, reputationProps, rubyRoundToTenths } from "./user-reputation-summary.ts";

// spec/modules/user/reputation_summary_spec.rb: two products with 8 fives + 3 fours + 1 one.
const SPEC_AGGREGATE = [2, 12, 8 * 5 + 3 * 4 + 1] as const;

describe("buildReputationSummary", () => {
  it("weights the average by review count", () => {
    expect(buildReputationSummary(SPEC_AGGREGATE)).toEqual({ average: 4.4, count: 12, products_count: 2 });
  });

  it("returns null below 10 reviews", () => {
    expect(buildReputationSummary([2, 9, 45])).toBeNull();
  });

  it("returns null when reviews span fewer than 2 products", () => {
    expect(buildReputationSummary([1, 12, 60])).toBeNull();
  });

  it("returns null for a seller with no reviews", () => {
    expect(buildReputationSummary([0, 0, 0])).toBeNull();
  });
});

describe("rubyRoundToTenths", () => {
  it.each([
    [4.45, 4.5],
    [4.44, 4.4],
    [4.75, 4.8],
    [5, 5],
    [2.675, 2.7],
  ])("rounds %s to %s", (value, expected) => {
    expect(rubyRoundToTenths(value)).toBe(expected);
  });
});

describe("reputationProps", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.rows = [[2, 12, 53]];
    mocks.queries = [];
  });

  it("leaves the key out while the flag is off, without querying", async () => {
    mocks.enabled = false;
    expect(await reputationProps(1n)).toEqual({});
    expect(mocks.queries).toEqual([]);
  });

  it("serves the summary while the flag is on", async () => {
    expect(await reputationProps(1n)).toEqual({ reputation: { average: 4.4, count: 12, products_count: 2 } });
  });

  it("keeps the key as null when the seller is below the gate", async () => {
    mocks.rows = [[0, null, null]];
    expect(await reputationProps(1n)).toEqual({ reputation: null });
  });

  it("counts only alive, non-draft products that show reviews", async () => {
    await reputationProps(1n);
    const sql = mocks.queries[0]!;
    expect(sql).toContain("links.flags & 65536 != 0");
    expect(sql).toContain("= FALSE");
    expect(sql.match(/IS NULL/gu)).toHaveLength(3);
  });
});
