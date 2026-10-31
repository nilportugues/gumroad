// Replays query-cache.golden.json (scripts/golden/query-cache.rb): each scenario's ops run against
// the Node runtime under the same executor, and must send the statements ActiveRecord sent.
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { sqlReplay, type Statement } from "../../../worker/jobs/__fixtures__/sql-replay.ts";
import { execute, findInBatches, selectRows } from "../sql.ts";
import { cache, clearQueryCache, connectedTo, queryCacheClient, SIDEKIQ_EXECUTOR, uncached, WEB_EXECUTOR, withExecutor, type Role } from "./query-cache.ts";
import { transaction } from "./transaction.ts";

type Op = [string, ...unknown[]];
type Scenario = { name: string; ops: Op[]; statements: Statement[] };
type Golden = { start: number; web: Scenario[]; sidekiq: Scenario[] };

const golden = JSON.parse(readFileSync(new URL("__fixtures__/query-cache.golden.json", import.meta.url), "utf8")) as Golden;

async function run(ops: Op[], clock: { now: number }): Promise<void> {
  for (const [op, ...rest] of ops) {
    switch (op) {
      case "select":
        await selectRows(Prisma.raw(rest[0] as string));
        break;
      case "write":
      case "insert":
        await execute(Prisma.raw(rest[0] as string));
        break;
      case "lock": {
        const clause = rest[1] === true ? "FOR UPDATE" : (rest[1] as string);
        await selectRows(Prisma.raw(`SELECT \`users\`.* FROM \`users\` WHERE \`users\`.\`id\` = ${String(rest[0])} ${clause}`));
        break;
      }
      case "transaction":
        await transaction(() => run(rest[0] as Op[], clock));
        break;
      case "rollback":
        await transaction(
          async () => {
            await run(rest[0] as Op[], clock);
            return false;
          },
          { returningStatus: true },
        );
        break;
      case "uncached":
        await uncached(() => run(rest[1] as Op[], clock), { dirties: rest[0] as boolean });
        break;
      case "cache":
        await cache(() => run(rest[0] as Op[], clock));
        break;
      case "connected_to":
        await connectedTo(rest[0] as Role, () => run(rest[1] as Op[], clock));
        break;
      case "clear":
        clearQueryCache();
        break;
      case "find_in_batches":
        await findInBatches("users", null, rest[0] as number, () => run(rest[1] as Op[], clock));
        break;
      case "advance":
        clock.now += (rest[0] as number) * 1000;
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

describe.each([
  ["Puma", golden.web, WEB_EXECUTOR],
  ["Sidekiq", golden.sidekiq, SIDEKIQ_EXECUTOR],
] as const)("query cache under %s's executor", (_, scenarios, options) => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const sql = sqlReplay(scenario.statements);
    const clock = { now: golden.start * 1000 };
    await withExecutor(() => run(scenario.ops, clock), { ...options, now: () => clock.now });
    expect(sql.log).toEqual(sql.expected);
  });
});

describe("query cache", () => {
  it("hands out copies of the cached rows", async () => {
    sqlReplay([{ sql: "SELECT 1", result: { fields: ["a"], rows: [[1]] } }]);
    await withExecutor(async () => {
      const [first] = await selectRows<{ a: number }>(Prisma.sql`SELECT 1`);
      first!.a = 2;
      expect(await selectRows(Prisma.sql`SELECT 1`)).toEqual([{ a: 1 }]);
    });
  });

  it("keys on the rendered statement, so equal binds of different JS types share an entry", async () => {
    const sql = sqlReplay([{ sql: "SELECT 1 FROM `users` WHERE `id` = 5", result: { fields: ["1"], rows: [[1]] } }]);
    await withExecutor(async () => {
      await selectRows(Prisma.sql`SELECT 1 FROM \`users\` WHERE \`id\` = ${5}`);
      await selectRows(Prisma.sql`SELECT 1 FROM \`users\` WHERE \`id\` = ${5n}`);
    });
    expect(sql.log).toHaveLength(1);
  });

  it("is off outside an executor", async () => {
    const sql = sqlReplay([{ sql: "SELECT 1" }, { sql: "SELECT 1" }]);
    await selectRows(Prisma.sql`SELECT 1`);
    await selectRows(Prisma.sql`SELECT 1`);
    expect(sql.log).toHaveLength(2);
  });

  it("joins an enclosing executor", async () => {
    const sql = sqlReplay([{ sql: "SELECT 1" }]);
    await withExecutor(async () => {
      await selectRows(Prisma.sql`SELECT 1`);
      await withExecutor(() => selectRows(Prisma.sql`SELECT 1`), SIDEKIQ_EXECUTOR);
    });
    expect(sql.log).toHaveLength(1);
  });

  it("caches tagged-template reads and is cleared by typed writes on a wrapped client", async () => {
    const reads: string[] = [];
    const client = queryCacheClient({
      $queryRaw: async (query: Prisma.Sql) => {
        reads.push(query.sql);
        return [];
      },
      user: { update: async () => ({}) },
    });
    await withExecutor(async () => {
      await client.$queryRaw(Prisma.sql`SELECT 1`);
      await (client.$queryRaw as unknown as (s: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
      await client.user.update();
      await client.$queryRaw(Prisma.sql`SELECT 1`);
    });
    expect(reads).toEqual(["SELECT 1", "SELECT 1"]);
  });
});
