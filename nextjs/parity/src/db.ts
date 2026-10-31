import type { PrismaClient } from "@prisma/client";

import {
  type Json,
  quoteIdentifier,
  resolveDateToken,
  resolveTimeToken,
  selectExpression,
  type TableDump,
  type Tables,
} from "./canonical";
import type { Seed } from "./fixture";

// The replayer only needs raw SQL; anything that can run it against the replay database fits.
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  // Runs `fn` on a single connection, for session variables that must apply to the next query.
  pinned<T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

type RawClient = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export function prismaExecutor(client: PrismaClient): SqlExecutor {
  return {
    ...rawExecutor(client),
    pinned: (fn) => client.$transaction((tx) => fn(pinnedExecutor(tx)), { timeout: 60_000 }),
  };
}

function rawExecutor(raw: RawClient): Omit<SqlExecutor, "pinned"> {
  return {
    query: (sql, params = []) => raw.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params),
    execute: async (sql, params = []) => {
      await raw.$executeRawUnsafe(sql, ...params);
    },
  };
}

function pinnedExecutor(tx: RawClient): SqlExecutor {
  const executor: SqlExecutor = { ...rawExecutor(tx), pinned: (fn) => fn(executor) };
  return executor;
}

export const IGNORED_TABLES = new Set(["schema_migrations", "ar_internal_metadata"]);

export type Schema = Record<string, Omit<TableDump, "rows">>;

const schemaCache = new WeakMap<SqlExecutor, Schema>();

export async function readSchema(sql: SqlExecutor): Promise<Schema> {
  const cached = schemaCache.get(sql);
  if (cached) return cached;
  const rows = await sql.query(`
    SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS d, c.COLUMN_KEY AS k
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
  const schema: Schema = {};
  for (const { t, c, d, k } of rows as { t: string; c: string; d: string; k: string }[]) {
    if (IGNORED_TABLES.has(t)) continue;
    const table = (schema[t] ??= { columns: [], primaryKey: [] });
    table.columns.push([c, d.toLowerCase()]);
    if (k === "PRI") table.primaryKey.push(c);
  }
  schemaCache.set(sql, schema);
  return schema;
}

export async function nonEmptyTables(sql: SqlExecutor, schema: Schema): Promise<string[]> {
  const tables = Object.keys(schema);
  if (tables.length === 0) return [];
  const union = tables
    .map((table) => `SELECT ? AS t FROM DUAL WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(table)})`)
    .join(" UNION ALL ");
  const rows = await sql.query(union, tables);
  return rows.map((row) => String(row.t)).sort();
}

export async function dump(sql: SqlExecutor, schema: Schema, tables: Iterable<string>): Promise<Tables> {
  const out: Tables = {};
  for (const table of [...new Set(tables)].sort()) {
    const meta = schema[table];
    if (!meta) throw new Error(`Table ${table} is not in the replay database`);
    const columns = meta.columns.map(([name, type], i) => `${selectExpression(name, type)} AS c${i}`);
    const order = (meta.primaryKey.length ? meta.primaryKey : meta.columns.map(([name]) => name)).map(quoteIdentifier);
    const rows = await sql.query(`SELECT ${columns.join(", ")} FROM ${quoteIdentifier(table)} ORDER BY ${order.join(", ")}`);
    out[table] = { ...meta, rows: rows.map((row) => meta.columns.map((_, i) => rawString(row[`c${i}`]))) };
  }
  return out;
}

function rawString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

export async function autoIncrements(sql: SqlExecutor): Promise<Record<string, number>> {
  return sql.pinned(async (pinned) => {
    // information_schema caches counters for a day unless told not to.
    await pinned.execute("SET SESSION information_schema_stats_expiry = 0");
    const rows = await pinned.query(
      "SELECT TABLE_NAME AS t, AUTO_INCREMENT AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND AUTO_INCREMENT > 1",
    );
    return Object.fromEntries(rows.map((row) => [String(row.t), Number(row.n)]));
  });
}

const INSERT_BATCH_ROWS = 500;

// Replaces the replay database's contents with the fixture's: the same rows and the same
// AUTO_INCREMENT counters, so ids the port assigns match the ones Rails assigned.
export async function seedDatabase(sql: SqlExecutor, seed: Seed, now: Date): Promise<void> {
  const schema = await readSchema(sql);
  const dirty = new Set([
    ...(await nonEmptyTables(sql, schema)),
    ...Object.keys(await autoIncrements(sql)).filter((table) => schema[table]),
    ...Object.keys(seed.tables),
  ]);
  for (const table of [...dirty].sort()) {
    if (!schema[table]) throw new Error(`Fixture seeds ${table}, which is not in the replay database`);
    await sql.execute(`TRUNCATE TABLE ${quoteIdentifier(table)}`);
  }

  for (const [table, seedTable] of Object.entries(seed.tables)) {
    const types = new Map(schema[table]!.columns);
    const columns = Object.keys(seedTable.columns);
    const unknown = columns.filter((column) => !types.has(column));
    if (unknown.length) throw new Error(`Replay database is missing ${table}.${unknown.join(", ")}; regenerate it from db/schema.rb`);

    for (let start = 0; start < seedTable.rows.length; start += INSERT_BATCH_ROWS) {
      const batch = seedTable.rows.slice(start, start + INSERT_BATCH_ROWS);
      const params: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((column) => {
          const { placeholder, value } = sqlValue(row[column] ?? null, types.get(column)!, now);
          params.push(value);
          return placeholder;
        });
        return `(${placeholders.join(", ")})`;
      });
      await sql.execute(
        `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${tuples.join(", ")}`,
        params,
      );
    }
  }

  for (const [table, value] of Object.entries(seed.autoIncrement)) {
    if (!schema[table]) continue;
    await sql.execute(`ALTER TABLE ${quoteIdentifier(table)} AUTO_INCREMENT = ${Number(value)}`);
  }
}

function sqlValue(value: Json, dataType: string, now: Date): { placeholder: string; value: unknown } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.$base64 === "string") return { placeholder: "FROM_BASE64(?)", value: value.$base64 };
    if (typeof value.$big === "string") return { placeholder: "?", value: value.$big };
  }
  if (typeof value === "string") {
    if (dataType === "datetime" || dataType === "timestamp") {
      const time = resolveTimeToken(value, now);
      if (time) return { placeholder: "?", value: formatDbTime(time) };
    }
    if (dataType === "date") {
      const date = resolveDateToken(value, now);
      if (date) return { placeholder: "?", value: date.toISOString().slice(0, 10) };
    }
  }
  return { placeholder: "?", value };
}

function formatDbTime(time: Date): string {
  return time.toISOString().replace("T", " ").replace("Z", "");
}
