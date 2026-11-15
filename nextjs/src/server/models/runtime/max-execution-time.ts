// Port of WithMaxExecutionTime.timeout_queries (lib/utilities/with_max_execution_time.rb). MySQL's `max_execution_time` is a
// session variable, and ActiveRecord runs the block on the one connection it set it on. The shared PrismaClient is a pool, so a
// `set` there would land on a connection the block's reads may never use. The block therefore gets a connection of its own:
// a PrismaClient with a single-connection pool, in autocommit like any ActiveRecord connection (not a transaction: statements
// commit one by one and no row lock outlives its statement). sql.ts and transaction.ts send every statement through it while
// the block runs; code that reaches for the shared `db` directly is not covered.
//
// Rails also caps the `reading` role's connection when replicas are configured. Node has no replica client, so there is no
// second connection to cap. Statements: `select @@max_execution_time`, `set max_execution_time = <ms>`, the block, then
// `set max_execution_time = <previous>` (scripts/golden/with-max-execution-time.rb, __fixtures__/with-max-execution-time.golden.json).
import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma, PrismaClient } from "@prisma/client";

// What a pinned connection must offer: the statements sql.ts sends and the transaction a model write opens.
export type PinnedClient = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "$transaction">;
export type PinnedSession = { client: PinnedClient; close: () => Promise<void> };

// WithMaxExecutionTime::QueryTimeoutError < Timeout::Error. The cause is the driver error.
export class QueryTimeoutError extends Error {
  override name = "QueryTimeoutError";
}

// MySQL's ER_QUERY_TIMEOUT text, which Rails matches on too.
const TIMEOUT_MESSAGE = "maximum statement execution time exceeded";
const MILLISECONDS_PER_SECOND = 1000;

const storage = new AsyncLocalStorage<PinnedClient>();

// The connection the running block owns, else null (the shared pool).
export const pinnedClient = (): PinnedClient | null => storage.getStore() ?? null;

// A PrismaClient whose pool holds exactly one connection. `pool_timeout=0` makes a second concurrent statement wait for it, as it
// would wait for the one ActiveRecord connection, rather than fail after Prisma's 10 seconds.
function openDedicatedSession(): PinnedSession {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "0");
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  return { client, close: () => client.$disconnect() };
}

let openSession: () => PinnedSession = openDedicatedSession;

// Tests swap in a recording or differently configured session; production opens a dedicated one.
export function setPinnedSessionFactory(next: () => PinnedSession): void {
  openSession = next;
}

const isTimeout = (error: unknown) => error instanceof Error && error.message.includes(TIMEOUT_MESSAGE);

export async function timeoutQueries<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const maxExecutionTime = Math.trunc(seconds * MILLISECONDS_PER_SECOND);
  // A nested block caps the connection the outer one owns, then puts the outer cap back.
  const outer = storage.getStore();
  const session = outer ? null : openSession();
  const client = outer ?? session!.client;

  let previous: unknown;
  try {
    previous = (await client.$queryRaw<Record<string, unknown>[]>(Prisma.sql`select @@max_execution_time`))[0]?.[
      "@@max_execution_time"
    ];
    await client.$executeRaw(Prisma.sql`set max_execution_time = ${Prisma.raw(String(maxExecutionTime))}`);
    return await storage.run(client, fn);
  } catch (error) {
    if (isTimeout(error)) throw new QueryTimeoutError((error as Error).message, { cause: error });
    throw error;
  } finally {
    try {
      if (previous !== undefined) {
        await client.$executeRaw(Prisma.sql`set max_execution_time = ${Prisma.raw(String(previous))}`);
      }
    } catch {
      // A connection that died mid-block cannot be restored, and is about to be closed.
    }
    // The dedicated connection is closed rather than returned: the cap dies with the session.
    if (session) await session.close();
  }
}
