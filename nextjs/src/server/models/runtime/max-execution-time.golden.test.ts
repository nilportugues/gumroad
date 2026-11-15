// Replays __fixtures__/with-max-execution-time.golden.json (scripts/golden/with-max-execution-time.rb): the statements
// WithMaxExecutionTime.timeout_queries sent on a single pool, in order, and the error class it raised. `replicas` in the same file
// is production Sidekiq, which sends each cap and restore a second time on the reading role's connection; Node has one pool.
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { execute, selectRows, setSqlClient } from "../sql.ts";

import golden from "./__fixtures__/with-max-execution-time.golden.json" with { type: "json" };
import {
  QueryTimeoutError,
  setPinnedSessionFactory,
  timeoutQueries,
  type PinnedSession,
} from "./max-execution-time.ts";

type Entry = {
  sql: string;
  result: { rows?: unknown[][]; affected?: number; error?: { number: number; message: string } };
};
type Case = {
  name: string;
  seconds: number;
  statements: Entry[];
  error: { class: string; superclass: string } | null;
  value: unknown;
};

const SCRATCH_TABLE = "ws88_slow";
const SLOW = `select sum(a.id * b.id + c.id) from ${SCRATCH_TABLE} a join ${SCRATCH_TABLE} b join ${SCRATCH_TABLE} c`;

// What the case's block does, by name: it runs the statements the golden shows between the cap and its restore.
const BLOCKS: Record<string, () => Promise<unknown>> = {
  "a block that returns a value": async () => "returned",
  "a block that writes": async () => {
    await execute(Prisma.raw(`insert into ${SCRATCH_TABLE} (id) values (1000)`));
  },
  "nested blocks": async () => {
    await timeoutQueries(3, async () => undefined);
  },
  "a block that raises": async () => {
    throw new ArgumentError("boom");
  },
  "a statement over the cap": async () => {
    await selectRows(Prisma.raw(SLOW));
  },
};
class ArgumentError extends Error {}

// A session that answers from the golden and fails the test if Node sends anything the recording did not.
function replaySession(statements: Entry[], sent: string[]): PinnedSession {
  const next = (query: { sql: string }) => {
    sent.push(query.sql);
    const entry = statements[sent.length - 1];
    if (!entry) throw new Error(`unexpected statement ${query.sql}`);
    expect(query.sql).toBe(entry.sql);
    if (entry.result.error) {
      throw new Error(
        `Raw query failed. Code: \`${entry.result.error.number}\`. Message: \`${entry.result.error.message}\``,
      );
    }
    return entry.result;
  };
  const client = {
    $queryRaw: async (query: { sql: string }) => {
      const result = next(query);
      return (result.rows ?? []).map(([value]) => ({ "@@max_execution_time": value }));
    },
    $executeRaw: async (query: { sql: string }) => next(query).affected ?? 0,
    $transaction: async () => {
      throw new Error("a block is not a transaction");
    },
  };
  return { client: client as never, close: async () => undefined };
}

afterEach(() => setSqlClient(async () => (await import("../../../lib/db.ts")).db));

describe("timeoutQueries replaying Rails", () => {
  for (const c of golden.single_pool as Case[]) {
    it(`sends the statements Rails sends: ${c.name}`, async () => {
      const sent: string[] = [];
      setPinnedSessionFactory(() => replaySession(c.statements, sent));
      // Nothing may reach the shared pool while the block runs.
      setSqlClient(() => {
        throw new Error("the block's statement reached the shared client");
      });

      const run = timeoutQueries(c.seconds, BLOCKS[c.name] ?? (async () => undefined));
      if (c.error) {
        const error = await run.catch((e) => e);
        // Timeout::Error subclass in Rails; every other error passes through as it is.
        if (c.error.class === "WithMaxExecutionTime::QueryTimeoutError")
          expect(error).toBeInstanceOf(QueryTimeoutError);
        else expect(error).toBeInstanceOf(ArgumentError);
      } else {
        await expect(run).resolves.toBe(c.value ?? undefined);
      }
      expect(sent).toEqual(c.statements.map((s) => s.sql));
    });
  }
});
