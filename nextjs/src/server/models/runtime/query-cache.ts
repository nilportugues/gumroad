// Port of ActiveRecord::ConnectionAdapters::QueryCache (activerecord 8.1) and of the executor
// hooks that switch it on (ActiveRecord::QueryCache::ExecutorHooks), plus the clearing
// lib/mysql2_proxy_routing.rb adds when mysql2_proxy changes the pool a SELECT is served from.
// runtime/__fixtures__/query-cache.golden.json pins it against ActiveRecord (scripts/golden/query-cache.rb).
//
// Inside an executor scope a SELECT is answered from memory when the same statement text (binds
// are inlined: mysql2 runs without prepared statements) was answered since the last write. Each
// pool has its own store per job or request (Rails: per thread), an LRU of DEFAULT_QUERY_CACHE_SIZE
// entries. Any write clears every store unless the writing pool is `uncached(fn, { dirties: false })`,
// and so does rolling back a transaction that sent a statement. Locking reads are never cached,
// and callers get a fresh copy of the rows.
//
// Every statement reaches this module through queryCacheClient(): sql.ts wraps the client it
// hands out and transaction.ts wraps each transaction client, so model services, `selectRows`
// and direct `tx.$queryRaw` calls all go through the same cache.
import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma } from "@prisma/client";

import { renderSql } from "./quoting.ts";
import { currentTransaction } from "./transaction.ts";

export type Role = "writing" | "reading";

// QueryCache::DEFAULT_SIZE; database.yml sets no `query_cache`.
export const DEFAULT_QUERY_CACHE_SIZE = 100;
// config.proxy_delay in config/initializers/active_record_proxy_adapters.rb.
const PROXY_DELAY_SECONDS = 2;

export type ExecutorOptions = {
  // Production Sidekiq boots with USE_DB_WORKER_REPLICAS=true: ApplicationRecord's writing pool is
  // a mysql2_proxy connection that sends plain reads to a replica (Mysql2ProxyRouting::ServingPoolCache
  // clears the cache whenever that changes), and `connected_to(role: :reading)` is a second pool.
  // Puma leaves the flag unset: one pool.
  replicas?: boolean;
  // `query_cache:` in database.yml. Unset: DEFAULT_QUERY_CACHE_SIZE; 0 or null: no limit.
  maxSize?: number | null;
  // Time.now in milliseconds, for proxy_delay.
  now?: () => number;
};

// Sidekiq::Rails::Reloader wraps every job in the Rails executor.
export const SIDEKIQ_EXECUTOR: ExecutorOptions = { replicas: true };
// ActionDispatch::Executor does the same for every request.
export const WEB_EXECUTOR: ExecutorOptions = { replicas: false };

type Rows = unknown[];
type PoolName = "primary" | "replica";
type Flags = { enabled: boolean; dirties: boolean };
type ProxyState = { serving: Role | null; lastWrite: number; now: () => number };
type Store = { maps: Record<PoolName, Map<string, Rows>>; replicas: boolean; maxSize: number | null; proxy: ProxyState | null };
type Frame = { store: Store; executor: boolean; flags: Record<PoolName, Flags>; role: Role | null };

const frames = new AsyncLocalStorage<Frame>();
const OFF: Flags = { enabled: false, dirties: true };
const ON: Flags = { enabled: true, dirties: true };

function newStore(options: ExecutorOptions): Store {
  const maxSize = options.maxSize === undefined ? DEFAULT_QUERY_CACHE_SIZE : options.maxSize || null;
  const proxy = options.replicas ? { serving: null, lastWrite: 0, now: options.now ?? Date.now } : null;
  return { maps: { primary: new Map(), replica: new Map() }, replicas: !!options.replicas, maxSize, proxy };
}

// The pool `ApplicationRecord.connection` is on: the reading role's own pool inside
// `connected_to(role: :reading)` when replicas are configured, else the writing one.
const poolOf = (frame: Frame): PoolName => (frame.role === "reading" && frame.store.replicas ? "replica" : "primary");

function withFlags<T>(frame: Frame, pool: PoolName, flags: Flags, fn: () => Promise<T>): Promise<T> {
  return frames.run({ ...frame, flags: { ...frame.flags, [pool]: flags } }, fn);
}

// Rails.application.executor.wrap: a nested wrap joins the running one; the outermost one starts
// every pool with an empty, enabled cache and drops it when done (ExecutorHooks.run/complete).
export function withExecutor<T>(fn: () => Promise<T>, options: ExecutorOptions = WEB_EXECUTOR): Promise<T> {
  const current = frames.getStore();
  if (current?.executor) return fn();
  return frames.run({ store: newStore(options), executor: true, flags: { primary: ON, replica: ON }, role: null }, fn);
}

// ActiveRecord::Base.cache: enabled for the block, and emptied afterwards unless it already was.
export async function cache<T>(fn: () => Promise<T>): Promise<T> {
  const current = frames.getStore() ?? { store: newStore(WEB_EXECUTOR), executor: false, flags: { primary: OFF, replica: OFF }, role: null };
  const pool = poolOf(current);
  try {
    return await withFlags(current, pool, ON, fn);
  } finally {
    if (!current.flags[pool].enabled) current.store.maps[pool].clear();
  }
}

// Model.uncached: reads on the current pool bypass its cache (and leave it as it is); writes still
// clear every pool's unless `dirties: false`.
export function uncached<T>(fn: () => Promise<T>, options: { dirties?: boolean } = {}): Promise<T> {
  const current = frames.getStore();
  if (!current) return fn();
  return withFlags(current, poolOf(current), { enabled: false, dirties: options.dirties ?? true }, fn);
}

// ApplicationRecord.connected_to(role:). Node itself always talks to the primary; the role only
// decides which store answers and when the proxy would have cleared it.
export function connectedTo<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const current = frames.getStore();
  if (!current) return fn();
  return frames.run({ ...current, role }, fn);
}

// connection.clear_query_cache, which Persistence#reload and association reload(true) call.
export function clearQueryCache(): void {
  const frame = frames.getStore();
  frame?.store.maps[poolOf(frame)].clear();
}

// clear_query_caches_for_current_thread: what a write does.
function clearAll(store: Store): void {
  store.maps.primary.clear();
  store.maps.replica.clear();
}

// --- mysql2_proxy routing (active_record_proxy_adapters 0.11.1 PrimaryReplicaProxy) -----------------
// Ruby's \A is ^ and \Z is (?=\n?$) here; neither regexp uses /m, so `.` stops at a newline.
const PRIMARY_MATCHERS = [/^\s*select.+for update(?=\n?$)/iu, /select.+lock in share mode(?=\n?$)/iu, /^\s*select.+(nextval|currval|lastval|get_lock|release_lock|pg_advisory_lock|pg_advisory_unlock)\(/iu];
const CTE_MATCHER = /^\s*WITH\s+(\S+\s+AS\s+\(\s?[\s\S]*\))/iu;
const REPLICA_MATCHERS = [/^\s*(select)\s/iu, /^\s*WITH\s+(\S+\s+AS\s+\(\s?[\s\S]*\))\s*select/iu];
const ALL_MATCHER = /^\s*set\s/iu;
const SKIP_ALL_MATCHER = /^\s*set\s+local\s/iu;
const WRITE_MATCHERS = [
  /(^|\s+?)BEGIN/iu,
  /(^|\s+?)COMMIT/iu,
  /(^|\s+?)ROLLBACK/iu,
  /(^|\s+?)(INSERT\s+?INTO\s+?\S+?)/iu,
  /(^|\s+?)UPDATE\s+?\S+?/iu,
  /(^|\s+?)DELETE\s+?FROM\s+?\S+?/iu,
  /(^|\s+?)DROP\s/iu,
];
const isWriteStatement = (text: string) => WRITE_MATCHERS.some((m) => m.test(text));

function recentWrite(proxy: ProxyState): boolean {
  return proxy.now() / 1000 - proxy.lastWrite < PROXY_DELAY_SECONDS;
}

// PrimaryReplicaProxy#roles_for, reduced to the role whose connection serves the statement last.
function roleFor(frame: Frame, proxy: ProxyState, text: string): Role {
  if (frame.role) return frame.role;
  if (currentTransaction() || recentWrite(proxy)) return "writing";
  if (ALL_MATCHER.test(text) && !SKIP_ALL_MATCHER.test(text)) return "writing";
  if (CTE_MATCHER.test(text) && isWriteStatement(text)) return "writing";
  if (PRIMARY_MATCHERS.some((m) => m.test(text))) return "writing";
  return REPLICA_MATCHERS.some((m) => m.test(text)) ? "reading" : "writing";
}

// connection_for: a statement the primary runs that looks like a write pins reads to the primary
// for proxy_delay.
function afterStatement(proxy: ProxyState, role: Role, text: string): void {
  if (role === "writing" && isWriteStatement(text)) proxy.lastWrite = proxy.now() / 1000;
}

// --- statements ------------------------------------------------------------------------------------

export type SqlText = { sql: string; values: readonly unknown[] };

// QueryCache's key is the statement text. A value Arel would not quote yields a key that is
// still unique to it.
function textOf(sql: SqlText): string {
  try {
    return renderSql(sql as Prisma.Sql);
  } catch {
    return `${sql.sql}\0${JSON.stringify(sql.values, (_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value))}`;
  }
}

// QueryCache#select_all skips a relation with `lock`, whose clause Arel always puts last.
const LOCKING_READ = /\b(FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE)(\s+(NOWAIT|SKIP LOCKED))?\s*$/iu;

// ActiveRecord::Result#dup copies the rows; the cached ones stay untouched by the caller.
function copyRows(rows: Rows): Rows {
  return rows.map((row) => (Array.isArray(row) ? [...row] : row !== null && typeof row === "object" ? { ...row } : row));
}

// QueryCache#select_all, under Mysql2ProxyRouting::ServingPoolCache on the proxy pool.
export async function cachedSelect<T>(sql: SqlText, run: () => Promise<T[]>): Promise<T[]> {
  const frame = frames.getStore();
  if (!frame) return run();
  const pool = poolOf(frame);
  const { enabled } = frame.flags[pool];
  const map = frame.store.maps[pool];
  // The reading pool is a plain mysql2 connection: no routing.
  const proxy = pool === "primary" ? frame.store.proxy : null;
  const text = proxy || enabled ? textOf(sql) : "";
  let role: Role | null = null;
  if (proxy) {
    role = roleFor(frame, proxy, text);
    if (enabled && proxy.serving !== role) {
      map.clear();
      proxy.serving = role;
    }
  }
  try {
    if (!enabled || LOCKING_READ.test(sql.sql)) return await run();
    const hit = map.get(text);
    if (hit) {
      map.delete(text);
      map.set(text, hit);
      return copyRows(hit) as T[];
    }
    if (frame.store.maxSize !== null && map.size >= frame.store.maxSize) map.delete(map.keys().next().value!);
    const rows = await run();
    map.set(text, rows);
    return copyRows(rows) as T[];
  } finally {
    if (proxy && role) afterStatement(proxy, role, text);
  }
}

// The dirties_query_cache wrapper on insert/update/delete/execute/exec_query/...: caches are
// cleared before the statement runs. `sql` is null for a typed Prisma write.
export function noteWrite(sql: SqlText | null): void {
  const frame = frames.getStore();
  if (!frame) return;
  if (frame.flags[poolOf(frame)].dirties) clearAll(frame.store);
  const proxy = frame.store.proxy;
  if (proxy && frame.role !== "reading" && (sql === null || isWriteStatement(textOf(sql)))) proxy.lastWrite = proxy.now() / 1000;
}

// rollback_db_transaction dirties too; it only runs once the transaction sent a statement.
export function noteRollback(): void {
  const frame = frames.getStore();
  if (frame?.flags.primary.dirties) clearAll(frame.store);
}

// --- clients ---------------------------------------------------------------------------------------

const wrappedClients = new WeakSet<object>();
const DELEGATE_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);

function toSql(query: unknown, values: unknown[]): Prisma.Sql {
  // A tagged-template call (`$queryRaw\`...\``) passes the strings and values separately.
  if (Array.isArray(query) && "raw" in query) return Prisma.sql(query as unknown as TemplateStringsArray, ...values);
  return query as Prisma.Sql;
}

function wrapDelegate(delegate: object, onStatement?: () => void): object {
  return new Proxy(delegate, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        if (DELEGATE_WRITES.has(prop)) noteWrite(null);
        onStatement?.();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// A Prisma client (or transaction client) whose raw reads go through the cache and whose writes
// clear it. `onStatement` runs before anything is actually sent (not for a cache hit).
export function queryCacheClient<C extends object>(client: C, onStatement?: () => void): C {
  if (wrappedClients.has(client)) return client;
  const delegates = new Map<string | symbol, object>();
  const proxy = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "$queryRaw" && typeof value === "function") {
        return (query: unknown, ...values: unknown[]) => {
          const sql = toSql(query, values);
          return cachedSelect(sql, () => {
            onStatement?.();
            return value.call(target, sql);
          });
        };
      }
      if (prop === "$queryRawUnsafe" && typeof value === "function") {
        return (text: string, ...values: unknown[]) =>
          cachedSelect({ sql: text, values }, () => {
            onStatement?.();
            return value.call(target, text, ...values);
          });
      }
      if ((prop === "$executeRaw" || prop === "$executeRawUnsafe") && typeof value === "function") {
        return (query: unknown, ...values: unknown[]) => {
          const sql = prop === "$executeRaw" ? toSql(query, values) : { sql: query as string, values };
          noteWrite(sql);
          onStatement?.();
          return prop === "$executeRaw" ? value.call(target, sql) : value.call(target, query, ...values);
        };
      }
      if (typeof value === "function") return value.bind(target);
      if (typeof prop === "string" && !prop.startsWith("$") && value !== null && typeof value === "object") {
        let wrapped = delegates.get(prop);
        if (!wrapped) delegates.set(prop, (wrapped = wrapDelegate(value, onStatement)));
        return wrapped;
      }
      return value;
    },
  });
  wrappedClients.add(proxy);
  return proxy;
}
