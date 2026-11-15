// Outside a timeoutQueries block sql.ts and transaction() use the pooled client exactly as before; inside one they use the block's.
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
  calls: [] as string[],
  $queryRaw: async (q: { sql: string }) => {
    pool.calls.push(`pool:${q.sql}`);
    return [];
  },
  $executeRaw: async (q: { sql: string }) => {
    pool.calls.push(`pool:${q.sql}`);
    return 0;
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    pool.calls.push("pool:$transaction");
    return fn({ $queryRaw: pool.$queryRaw, $executeRaw: pool.$executeRaw });
  },
}));
vi.mock("../../../lib/db.ts", () => ({ db: pool }));

import { selectRows, execute, setSqlClient } from "../sql.ts";

import { setPinnedSessionFactory, timeoutQueries } from "./max-execution-time.ts";
import { transaction } from "./transaction.ts";

describe("routing outside and inside timeoutQueries", () => {
  it("sends statements and transactions to the pooled client when no block is active", async () => {
    pool.calls.length = 0;
    setSqlClient(async () => pool as never);
    await selectRows(Prisma.sql`SELECT 1`);
    await execute(Prisma.sql`UPDATE t SET a = 1`);
    await transaction(async () => undefined);
    expect(pool.calls).toEqual(["pool:SELECT 1", "pool:UPDATE t SET a = 1", "pool:$transaction"]);
  });

  it("sends statements and transactions to the block's client while one is active, and back to the pool afterwards", async () => {
    const calls: string[] = [];
    const record = (q: { sql: string }) => (calls.push(`pinned:${q.sql}`), []);
    const client = {
      $queryRaw: async (q: { sql: string }) => record(q),
      $executeRaw: async (q: { sql: string }) => record(q).length,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => (calls.push("pinned:$transaction"), fn({ $queryRaw: async (q: { sql: string }) => record(q), $executeRaw: async () => 0 })),
    };
    setPinnedSessionFactory(() => ({ client: client as never, close: async () => undefined }));
    pool.calls.length = 0;
    setSqlClient(async () => pool as never);
    await timeoutQueries(1, async () => {
      await selectRows(Prisma.sql`SELECT 2`);
      await transaction(async () => undefined);
    });
    await selectRows(Prisma.sql`SELECT 3`);
    expect(calls.filter((c) => c.includes("SELECT 2") || c.includes("$transaction"))).toEqual(["pinned:SELECT 2", "pinned:$transaction"]);
    expect(pool.calls).toEqual(["pool:SELECT 3"]);
  });
});
