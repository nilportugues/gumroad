// Raw statements for model code and jobs that need ActiveRecord's exact SQL (batching, locks,
// grouped aggregates), and the casts that turn `$queryRaw` rows into the shapes Prisma's typed
// client returns. Statements run on the open transaction when there is one, as ActiveRecord's
// connection would, and through the query cache (runtime/query-cache.ts).
import { Prisma, type PrismaClient } from "@prisma/client";

import { queryCacheClient, uncached } from "./runtime/query-cache.ts";
import type { Row } from "./runtime/record.ts";
import { currentTransaction } from "./runtime/transaction.ts";

export type SqlClient = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

let client: () => SqlClient | Promise<SqlClient> = async () => (await import("../../lib/db.ts")).db;

// Tests swap in a recording client; production uses the shared PrismaClient.
export function setSqlClient(next: () => SqlClient | Promise<SqlClient>): void {
  client = next;
}

// ActiveRecord::Base.connection: the open transaction, else the shared client.
export async function connection(): Promise<SqlClient> {
  return (currentTransaction() as SqlClient | null) ?? queryCacheClient(await client());
}

export async function selectRows<T = Row>(sql: Prisma.Sql): Promise<T[]> {
  return (await connection()).$queryRaw<T[]>(sql);
}

// Affected rows, as `delete_all` / `update_all` return.
export async function execute(sql: Prisma.Sql): Promise<number> {
  return Number(await (await connection()).$executeRaw(sql));
}

// MySQL quote_table_name / quote_column_name.
export const quoteName = (name: string) => `\`${name.replaceAll("`", "``")}\``;
export const table = (name: string) => Prisma.raw(quoteName(name));
export const column = (tableName: string, name: string) => Prisma.raw(`${quoteName(tableName)}.${quoteName(name)}`);

// `find_in_batches` / `find_each` over `SELECT table.*` (activerecord 8.1): ORDER BY id LIMIT n,
// then `AND id > <last id>`, stopping after a short batch. Batch loads skip the query cache
// (`skip_query_cache!`); the block does not.
// `select` replaces `table.*` for a relation with `select(:id)` and the like; `joins` is the text between the table and WHERE;
// `groupBy` is the GROUP BY / HAVING text a grouped relation keeps after the `id >` condition.
export async function findInBatches<T extends Row>(
  tableName: string,
  where: Prisma.Sql | null,
  batchSize: number,
  each: (rows: T[]) => Promise<void>,
  select: Prisma.Sql | null = null,
  joins: Prisma.Sql | null = null,
  groupBy: Prisma.Sql | null = null,
): Promise<void> {
  const id = column(tableName, "id");
  let after: unknown = null;
  for (;;) {
    const conditions = [where, after === null ? null : Prisma.sql`${id} > ${after}`].filter(
      (c): c is Prisma.Sql => c !== null,
    );
    const clause = conditions.length === 0 ? Prisma.empty : Prisma.sql` WHERE ${Prisma.join(conditions, " AND ")}`;
    const rows = await uncached(() =>
      selectRows<T>(
        Prisma.sql`SELECT ${select ?? Prisma.raw(`${quoteName(tableName)}.*`)} FROM ${table(tableName)}${joins ? Prisma.sql` ${joins}` : Prisma.empty}${clause}${groupBy ? Prisma.sql` ${groupBy}` : Prisma.empty} ORDER BY ${id} ASC LIMIT ${Prisma.raw(String(batchSize))}`,
      ),
    );
    if (rows.length === 0) return;
    await each(rows);
    if (rows.length < batchSize) return;
    after = rows.at(-1)!.id;
  }
}

// Arel's `IN (...)` for a non-empty list; Arel writes `1=0` for an empty one.
export function inList(values: readonly unknown[]): Prisma.Sql {
  return values.length === 0 ? Prisma.raw("1=0") : Prisma.sql`(${Prisma.join(values, ", ")})`;
}

// `where(column => [...])`: `= x` for one value, `IN (...)` for several, `1=0` for none.
export function columnIn(tableName: string, name: string, values: readonly unknown[]): Prisma.Sql {
  if (values.length === 0) return Prisma.raw("1=0");
  if (values.length === 1) return Prisma.sql`${column(tableName, name)} = ${values[0]}`;
  return Prisma.sql`${column(tableName, name)} IN ${inList(values)}`;
}

// `where.not(column => [...])`: `!= x` for one value, `NOT IN (...)` for several.
export function columnNotIn(tableName: string, name: string, values: readonly unknown[]): Prisma.Sql {
  if (values.length === 0) throw new Error("columnNotIn needs at least one value");
  if (values.length === 1) return Prisma.sql`${column(tableName, name)} != ${values[0]}`;
  return Prisma.sql`${column(tableName, name)} NOT IN ${inList(values)}`;
}

type FieldType = { type: string };
const fieldTypes = new Map<string, Map<string, FieldType>>();

function typesFor(model: Prisma.ModelName): Map<string, FieldType> {
  let types = fieldTypes.get(model);
  if (!types) {
    const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
    if (!dmmf) throw new Error(`Unknown Prisma model ${model}`);
    types = new Map(
      dmmf.fields
        .filter((f) => f.kind === "scalar" || f.kind === "enum")
        .map((f) => [f.dbName ?? f.name, { type: f.type }]),
    );
    fieldTypes.set(model, types);
  }
  return types;
}

export function tableName(model: Prisma.ModelName): string {
  const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dmmf) throw new Error(`Unknown Prisma model ${model}`);
  return dmmf.dbName ?? dmmf.name;
}

// A `SELECT table.*` row as the typed client would return it. MySQL hands raw queries a tinyint
// for booleans and a number for some bigints; the model runtime compares typed values.
export function castRow<R extends Row>(model: Prisma.ModelName, row: Row): R {
  const types = typesFor(model);
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const field = types.get(key);
    if (!field || value == null) {
      out[key] = value;
      continue;
    }
    switch (field.type) {
      case "BigInt":
        out[key] = BigInt(value as bigint | number | string);
        break;
      case "Int":
        out[key] = Number(value);
        break;
      case "Boolean":
        out[key] = typeof value === "boolean" ? value : Number(value) !== 0;
        break;
      case "DateTime":
        out[key] = value instanceof Date ? value : new Date(value as string);
        break;
      case "Decimal":
        out[key] = Prisma.Decimal.isDecimal(value) ? value : new Prisma.Decimal(String(value));
        break;
      default:
        out[key] = value;
    }
  }
  return out as R;
}

// ActiveRecord::RecordNotUnique: MySQL error 1062, which Prisma reports as P2002 on typed writes.
// ActiveRecord::LockWaitTimeout (ER_LOCK_WAIT_TIMEOUT).
export function isLockWaitTimeout(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return error.code === "P2010" && String(error.meta?.code) === "1205";
  return error instanceof Error && "errno" in error && (error as { errno: unknown }).errno === 1205;
}

// ActiveRecord::Deadlocked (ER_LOCK_DEADLOCK); Prisma reports a deadlock inside an interactive transaction as P2034.
export function isDeadlocked(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034" || (error.code === "P2010" && String(error.meta?.code) === "1213");
  }
  return error instanceof Error && "errno" in error && (error as { errno: unknown }).errno === 1213;
}

export function isRecordNotUnique(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2002" || (error.code === "P2010" && String(error.meta?.code) === "1062");
  }
  return error instanceof Error && "errno" in error && (error as { errno: unknown }).errno === 1062;
}
