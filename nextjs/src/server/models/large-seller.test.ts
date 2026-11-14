import { describe, expect, it } from "vitest";

import { createLargeSellerIfWarranted, SALES_LOWER_LIMIT } from "./large-seller.ts";
import { fakeDatabase } from "./runtime/testing.ts";
import { setSqlClient } from "./sql.ts";

// Answers the two reads create_if_warranted makes: `exists?` on large_sellers and the seller's purchase count.
function answering({ large, sales }: { large: boolean; sales: number }) {
  const statements: string[] = [];
  setSqlClient(() => ({
    $queryRaw: (async (query: { sql: string }) => {
      statements.push(query.sql);
      if (query.sql.includes("`large_sellers`")) return large ? [{ one: 1 }] : [];
      return [{ "COUNT(*)": BigInt(sales) }];
    }) as never,
    $executeRaw: (async () => 0) as never,
  }));
  return statements;
}

describe("LargeSeller.create_if_warranted", () => {
  const now = () => new Date("2026-11-02T15:00:00Z");

  it("writes a row, with the sales count, for a seller at the limit", async () => {
    const db = fakeDatabase();
    answering({ large: false, sales: SALES_LOWER_LIMIT });

    await createLargeSellerIfWarranted(42, now);

    expect(db.committed).toEqual([{ model: "largeSeller", op: "create", id: 1, data: expect.objectContaining({ user_id: 42, sales_count: SALES_LOWER_LIMIT }) }]);
  });

  it("writes nothing for a seller one sale short of the limit", async () => {
    const db = fakeDatabase();
    answering({ large: false, sales: SALES_LOWER_LIMIT - 1 });

    await createLargeSellerIfWarranted(42, now);

    expect(db.writes).toEqual([]);
  });

  it("does not count sales for a seller who already has a row", async () => {
    const db = fakeDatabase();
    const statements = answering({ large: true, sales: SALES_LOWER_LIMIT * 2 });

    await createLargeSellerIfWarranted(42, now);

    expect(db.writes).toEqual([]);
    expect(statements).toHaveLength(1);
  });
});
