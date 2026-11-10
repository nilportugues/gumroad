import { describe, expect, it } from "vitest";

process.env.OBFUSCATE_IDS_CIPHER_KEY ??= "library-test-obfuscate-key";
process.env.OBFUSCATE_IDS_NUMERIC_CIPHER_KEY ??= "123456789";

import { setSqlClient } from "../../models/sql.ts";

import { pickReplacementToken, replacementTokens, rubySplitComma } from "./library.ts";

// "a,b".split(",") in Ruby: trailing empty fields are dropped, and an empty string has no fields.
describe("rubySplitComma", () => {
  it.each([
    ["", []],
    ["a", ["a"]],
    ["a,b", ["a", "b"]],
    ["a,,b", ["a", "", "b"]],
    ["a,b,,", ["a", "b"]],
    [",a", ["", "a"]],
    [",", []],
  ])("splits %j", (value, fields) => {
    expect(rubySplitComma(value)).toEqual(fields);
  });
});

describe("pickReplacementToken", () => {
  const candidate = (purchase_state: string, token: string | null) => ({
    subscription_id: 1n,
    link_id: 2n,
    purchase_state,
    token,
  });

  it("takes the first renewal in the subscription's successful state that has a download page", () => {
    const candidates = [
      candidate("successful", null),
      candidate("test_successful", "test"),
      candidate("successful", "paid"),
    ];
    expect(pickReplacementToken(candidates, "successful")).toBe("paid");
    expect(pickReplacementToken(candidates, "test_successful")).toBe("test");
  });

  it("returns null when no renewal qualifies", () => {
    expect(pickReplacementToken([], "successful")).toBeNull();
    expect(pickReplacementToken([candidate("successful", null)], "successful")).toBeNull();
  });
});

describe("replacementTokens", () => {
  const purchase = (overrides: Record<string, unknown>) =>
    ({ id: 10n, subscription_id: 5n, link_id: 2n, flags: 4n, stripe_refunded: true, ...overrides }) as never;

  function answering(candidates: Record<string, unknown>[], subscriptionFlags = 0n) {
    const statements: string[] = [];
    setSqlClient(() => ({
      $queryRaw: (async (query: { sql: string }) => {
        statements.push(query.sql);
        if (query.sql.includes("FROM `subscriptions`")) return [{ id: 5n, flags: subscriptionFlags }];
        if (query.sql.includes("FROM `purchases`")) return candidates;
        throw new Error(`unexpected statement: ${query.sql}`);
      }) as never,
      $executeRaw: (async () => 0) as never,
    }));
    return statements;
  }

  it("makes no query when nothing is a refunded original subscription row", async () => {
    const statements = answering([]);
    const rows = [purchase({ stripe_refunded: false }), purchase({ subscription_id: null }), purchase({ flags: 0n })];
    expect((await replacementTokens(1n, rows)).size).toBe(0);
    expect(statements).toEqual([]);
  });

  it("links a refunded original to the viewer's paid renewal and restricts the search to the viewer", async () => {
    const statements = answering([
      { subscription_id: 5n, link_id: 2n, purchase_state: "successful", token: "renewal" },
    ]);
    expect((await replacementTokens(77n, [purchase({})])).get(10n)).toBe("renewal");
    expect(statements[0]).toContain("`purchases`.`purchaser_id` = ?");
    expect(statements[0]).toContain("ORDER BY `purchases`.`succeeded_at` DESC, `purchases`.`id` DESC");
  });

  it("maps a refunded gift receiver row, and leaves null when only a renewal without a download page exists", async () => {
    answering([{ subscription_id: 5n, link_id: 2n, purchase_state: "successful", token: null }]);
    expect((await replacementTokens(1n, [purchase({ flags: 32n })])).get(10n)).toBeNull();
  });

  it("looks for test_successful renewals on a test subscription", async () => {
    answering(
      [
        { subscription_id: 5n, link_id: 2n, purchase_state: "successful", token: "live" },
        { subscription_id: 5n, link_id: 2n, purchase_state: "test_successful", token: "test" },
      ],
      1n,
    );
    expect((await replacementTokens(1n, [purchase({})])).get(10n)).toBe("test");
  });
});
