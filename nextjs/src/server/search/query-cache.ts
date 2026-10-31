// ActiveRecord's query cache, which the Rails executor turns on around every Sidekiq job and
// request: inside a scope, a SELECT repeated with the same SQL and binds is answered from memory
// instead of being sent. Product indexing depends on it statement for statement (a variant's
// `link`, a product's `user` across a seller's products), so its reads go through `cachedSelect`.
//
// Not reproduced: the cache's 100-entry LRU bound, and clearing on writes (nothing that reads
// through here writes).
import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma } from "@prisma/client";

import { selectRows } from "../models/sql.ts";

const storage = new AsyncLocalStorage<Map<string, unknown[]>>();

// Joins the enclosing scope if there is one, as nested executor wraps do.
export function withQueryCache<T>(fn: () => Promise<T>): Promise<T> {
  return storage.getStore() ? fn() : storage.run(new Map(), fn);
}

function keyOf(sql: Prisma.Sql): string {
  return `${sql.sql}\0${JSON.stringify(sql.values, (_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value))}`;
}

export async function cachedSelect<T>(sql: Prisma.Sql): Promise<T[]> {
  const cache = storage.getStore();
  if (!cache) return selectRows<T>(sql);
  const key = keyOf(sql);
  const hit = cache.get(key);
  if (hit) return hit as T[];
  const rows = await selectRows<T>(sql);
  cache.set(key, rows);
  return rows;
}
