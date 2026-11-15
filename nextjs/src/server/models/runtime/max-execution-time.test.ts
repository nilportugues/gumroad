// Against a real MySQL: set MAX_EXECUTION_TIME_TEST_DATABASE_URL to a scratch database (names ending _ws<N>), e.g.
// mysql://root:password@127.0.0.1:3306/gumroad_test_ws88. Without it the file is skipped.
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { execute, selectRows, setSqlClient } from "../sql.ts";

import { QueryTimeoutError, timeoutQueries } from "./max-execution-time.ts";
import { transaction } from "./transaction.ts";

const URL_ENV = process.env.MAX_EXECUTION_TIME_TEST_DATABASE_URL;
const SCRATCH = /_(ws)?\d+[a-z]?$/u;
const ROWS = 400;
// ROWS^3 joined rows take about two seconds, far over CAP_SECONDS. A COUNT(*) is answered from an index in milliseconds
// and SLEEP() is ignored by the cap, so the sum has to be computed row by row.
const SLOW = Prisma.raw("SELECT SUM(a.id * b.id + c.id) AS n FROM ws88_rows a JOIN ws88_rows b JOIN ws88_rows c");
const SLOW_RESULT = (ROWS * (ROWS + 1)) / 2;
const CAP_SECONDS = 0.05;

describe.skipIf(!URL_ENV)("timeoutQueries against MySQL", () => {
  let pool: PrismaClient;
  const savedUrl = process.env.DATABASE_URL;

  const one = async <T = bigint>(sql: Prisma.Sql, client: Pick<PrismaClient, "$queryRaw"> = pool): Promise<T> => {
    const rows = await client.$queryRaw<Record<string, T>[]>(sql);
    return Object.values(rows[0]!)[0]!;
  };
  const inBlock = async <T = bigint>(sql: Prisma.Sql): Promise<T> => {
    const rows = await selectRows<Record<string, T>>(sql);
    return Object.values(rows[0]!)[0]!;
  };
  const connectionId = async () => Number(await inBlock(Prisma.sql`SELECT CONNECTION_ID()`));
  const alive = async (id: number) =>
    Number(await one(Prisma.sql`SELECT COUNT(*) FROM information_schema.processlist WHERE id = ${id}`)) === 1;

  beforeAll(async () => {
    if (!SCRATCH.test(new URL(URL_ENV!).pathname.slice(1)))
      throw new Error("Refusing to run against a non-scratch database");
    process.env.DATABASE_URL = URL_ENV;
    pool = new PrismaClient({ datasourceUrl: URL_ENV });
    setSqlClient(() => pool);
    await pool.$executeRawUnsafe("DROP TABLE IF EXISTS ws88_rows");
    await pool.$executeRawUnsafe("CREATE TABLE ws88_rows (id INT PRIMARY KEY, v INT NOT NULL DEFAULT 0) ENGINE=InnoDB");
    await pool.$executeRawUnsafe(
      `INSERT INTO ws88_rows (id) VALUES ${Array.from({ length: ROWS }, (_, i) => `(${i + 1})`).join(",")}`,
    );
  });
  afterAll(async () => {
    await pool?.$executeRawUnsafe("DROP TABLE IF EXISTS ws88_rows");
    await pool?.$disconnect();
    process.env.DATABASE_URL = savedUrl;
  });
  beforeEach(async () => {
    await pool.$executeRawUnsafe("UPDATE ws88_rows SET v = 0");
    await pool.$executeRawUnsafe("DELETE FROM ws88_rows WHERE id > 400");
  });

  it("caps a statement of the block that runs longer than the cap, raising QueryTimeoutError", async () => {
    const error = await timeoutQueries(CAP_SECONDS, () => selectRows(SLOW)).catch((e) => e);
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect(error.message).toContain("maximum statement execution time exceeded");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("lets a statement on another connection run past the same cap", async () => {
    const started = Date.now();
    await timeoutQueries(CAP_SECONDS, async () => {
      // The pool is not the block's connection, so the cap does not apply to it.
      expect(Number(await one(SLOW))).toBe(SLOW_RESULT ** 2 * ROWS + SLOW_RESULT * ROWS ** 2);
      expect(Date.now() - started).toBeGreaterThan(CAP_SECONDS * 1000);
    });
  });

  it("returns the block's value", async () => {
    await expect(timeoutQueries(5, async () => "value")).resolves.toBe("value");
  });

  it("reports the cap in milliseconds on the block's connection only", async () => {
    await timeoutQueries(2.5, async () => {
      expect(Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`))).toBe(2500);
      expect(Number(await one(Prisma.sql`SELECT @@max_execution_time`))).toBe(0);
    });
  });

  it("runs every statement of the block on one connection that is not a pool connection", async () => {
    await timeoutQueries(5, async () => {
      const ids = new Set<number>();
      for (let i = 0; i < 8; i++) ids.add(Number(await inBlock(Prisma.sql`SELECT CONNECTION_ID()`)));
      await Promise.all(
        Array.from({ length: 6 }, async () => ids.add(Number(await inBlock(Prisma.sql`SELECT CONNECTION_ID()`)))),
      );
      expect(ids.size).toBe(1);
      expect(Number(await one(Prisma.sql`SELECT CONNECTION_ID()`))).not.toBe([...ids][0]);
    });
  });

  it("runs in autocommit mode", async () => {
    await timeoutQueries(5, async () => {
      expect(Number(await inBlock(Prisma.sql`SELECT @@autocommit`))).toBe(1);
    });
  });

  it("commits a write at once, visible and unlocked from another connection before the block ends", async () => {
    await timeoutQueries(5, async () => {
      await execute(Prisma.sql`UPDATE ws88_rows SET v = 7 WHERE id = 1`);
      expect(Number(await one(Prisma.sql`SELECT v FROM ws88_rows WHERE id = 1`))).toBe(7);
      // A held row lock would make this wait out innodb_lock_wait_timeout and fail.
      await pool.$executeRawUnsafe("SET SESSION innodb_lock_wait_timeout = 1");
      const written = await pool.$executeRaw(Prisma.sql`UPDATE ws88_rows SET v = 8 WHERE id = 1`);
      expect(written).toBe(1);
      await execute(Prisma.sql`INSERT INTO ws88_rows (id, v) VALUES (1000, 1)`);
      expect(Number(await one(Prisma.sql`SELECT COUNT(*) FROM ws88_rows WHERE id = 1000`))).toBe(1);
    });
  });

  it("keeps each statement's commit when a later statement of the block fails", async () => {
    await expect(
      timeoutQueries(5, async () => {
        await execute(Prisma.sql`UPDATE ws88_rows SET v = 3 WHERE id = 2`);
        await selectRows(Prisma.sql`SELECT * FROM ws88_missing_table`);
      }),
    ).rejects.not.toBeInstanceOf(QueryTimeoutError);
    expect(Number(await one(Prisma.sql`SELECT v FROM ws88_rows WHERE id = 2`))).toBe(3);
  });

  it("opens a transaction of the block on the block's connection and commits it at its end", async () => {
    await timeoutQueries(5, async () => {
      const outside = await connectionId();
      await transaction(async () => {
        expect(await connectionId()).toBe(outside);
        expect(Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`))).toBe(5000);
        await execute(Prisma.sql`UPDATE ws88_rows SET v = 9 WHERE id = 3`);
      });
      expect(Number(await one(Prisma.sql`SELECT v FROM ws88_rows WHERE id = 3`))).toBe(9);
    });
  });

  it("gives two concurrent blocks each their own cap and leaves the pool uncapped", async () => {
    const seen = await Promise.all([
      timeoutQueries(1, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`));
      }),
      timeoutQueries(30, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`));
      }),
      // A block that times out while the others still run must not cap them.
      timeoutQueries(CAP_SECONDS, () => selectRows(SLOW)).catch((e) => e),
    ]);
    expect(seen.slice(0, 2)).toEqual([1000, 30000]);
    expect(seen[2]).toBeInstanceOf(QueryTimeoutError);
    // Every connection the pool holds, not just one of them.
    const caps = await Promise.all(Array.from({ length: 12 }, () => one(Prisma.sql`SELECT @@max_execution_time`)));
    expect(caps.map(Number)).toEqual(Array(12).fill(0));
  });

  it("restores the outer cap after a nested block", async () => {
    await timeoutQueries(10, async () => {
      const outer = await connectionId();
      await timeoutQueries(3, async () => {
        expect(await connectionId()).toBe(outer);
        expect(Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`))).toBe(3000);
      });
      expect(Number(await inBlock(Prisma.sql`SELECT @@max_execution_time`))).toBe(10000);
    });
  });

  it("closes the block's connection after the block returns", async () => {
    let id = 0;
    await timeoutQueries(5, async () => {
      id = await connectionId();
      expect(await alive(id)).toBe(true);
    });
    expect(await alive(id)).toBe(false);
  });

  it("closes the block's connection when the block raises", async () => {
    let id = 0;
    await expect(
      timeoutQueries(5, async () => {
        id = await connectionId();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await alive(id)).toBe(false);
  });

  it("closes the block's connection when a statement times out", async () => {
    let id = 0;
    await expect(
      timeoutQueries(CAP_SECONDS, async () => {
        id = await connectionId();
        await selectRows(SLOW);
      }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    expect(await alive(id)).toBe(false);
  });

  it("does not wrap an error that is not a timeout", async () => {
    const error = new Error("plain");
    await expect(timeoutQueries(5, async () => Promise.reject(error))).rejects.toBe(error);
  });
});
