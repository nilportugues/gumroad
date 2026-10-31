// Test double for the Prisma transaction client: records every write so model-service tests
// can assert on SQL-level effects and callback order without a database.
import type { Delegate } from "./define-model.ts";
import type { Row } from "./record.ts";
import { setTransactionRunner, type Tx } from "./transaction.ts";

export type Write = { model: string; op: "create" | "update" | "delete"; id: unknown; data?: Record<string, unknown> };

export function fakeDatabase() {
  const writes: Write[] = [];
  const committed: Write[] = [];
  let nextId = 1;
  let transactions = 0;
  const queries: { sql: string; values: unknown[] }[] = [];
  let queryResult: unknown[] = [];

  const delegate = <R extends Row>(model: string): Delegate<R> => ({
    async create({ data }) {
      const id = data.id ?? nextId++;
      writes.push({ model, op: "create", id, data: data as Record<string, unknown> });
      return { ...data, id } as unknown as R;
    },
    async update({ where, data }) {
      writes.push({ model, op: "update", id: where.id, data: data as Record<string, unknown> });
      return { ...data, id: where.id } as unknown as R;
    },
    async delete({ where }) {
      writes.push({ model, op: "delete", id: where.id });
      return { id: where.id } as unknown as R;
    },
  });

  const delegates = new Map<string, Delegate<Row>>();
  const $queryRaw = async (query: { sql: string; values: unknown[] }) => {
    queries.push({ sql: query.sql, values: query.values });
    return queryResult;
  };
  // `tx.user`, `tx.link`, ... resolve to recording delegates named after the property.
  const tx = new Proxy({} as Tx, {
    get(_, prop: string) {
      if (prop === "$queryRaw") return $queryRaw;
      if (!delegates.has(prop)) delegates.set(prop, delegate(prop));
      return delegates.get(prop);
    },
  });

  setTransactionRunner(async (fn) => {
    transactions++;
    const before = writes.length;
    try {
      const result = await fn(tx);
      committed.push(...writes.slice(before));
      return result;
    } catch (error) {
      writes.splice(before);
      throw error;
    }
  });

  return {
    tx,
    writes,
    committed,
    queries,
    delegate,
    get transactions() {
      return transactions;
    },
    nextQueryResult(rows: unknown[]) {
      queryResult = rows;
    },
  };
}
