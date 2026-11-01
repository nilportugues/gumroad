// Row loading for the document builders: ActiveRecord's exact statements for the association reads
// the Searchable concerns make, and the `as_json` of the values they return.
import { Prisma } from "@prisma/client";

import { castRow, selectRows } from "../models/sql.ts";
import type { Row } from "../models/runtime/record.ts";
import { type JsonValue, RubyFloat } from "./es-json.ts";
import { parseRubyJson } from "../jobs/sidekiq/ruby-json.ts";

export const q = (name: string) => `\`${name}\``;
export const col = (table: string, name: string) => Prisma.raw(`${q(table)}.${q(name)}`);

// `Model.find_by(id:)` / a belongs_to read: `SELECT t.* FROM t WHERE t.id = ? LIMIT 1`.
export async function findById(model: Prisma.ModelName, table: string, id: unknown): Promise<Row | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`${q(table)}.*`)} FROM ${Prisma.raw(q(table))} WHERE ${col(table, "id")} = ${id} LIMIT 1`);
  return row ? castRow(model, row) : null;
}

// `SELECT t.* FROM t WHERE <conditions> LIMIT 1`, for a has_one.
export async function findOneWhere(model: Prisma.ModelName, table: string, where: Prisma.Sql, suffix: Prisma.Sql = Prisma.empty): Promise<Row | null> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`${q(table)}.*`)} FROM ${Prisma.raw(q(table))} WHERE ${where}${suffix} LIMIT 1`);
  return row ? castRow(model, row) : null;
}

// `relation.sum(:column)`: SUM over no rows is NULL, which ActiveRecord reports as 0.
export async function sumOf(sql: Prisma.Sql): Promise<number> {
  const [row] = await selectRows<Record<string, unknown>>(sql);
  const value = row ? Object.values(row)[0] : null;
  return value === null || value === undefined ? 0 : Number(value);
}

// Object#blank? for the strings these models hold.
export const isBlank = (value: unknown): boolean => value === null || value === undefined || (typeof value === "string" && /^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(value)) || value === false;
export const presence = <T>(value: T): T | null => (isBlank(value) ? null : value);

// String#split(sep) drops trailing empty fields.
export function rubySplit(value: string, separator: string): string[] {
  const parts = value.split(separator);
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

// `attributes[name].as_json` for a column value read through castRow.
export function attributeAsJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return `${value.toISOString().slice(0, 19)}Z`;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (Prisma.Decimal.isDecimal(value)) {
    const fixed = (value as Prisma.Decimal).toFixed();
    return fixed.includes(".") ? fixed : `${fixed}.0`;
  }
  if (value instanceof RubyFloat) return value;
  return value as JsonValue;
}

// A `t.json` column: the driver may hand back text or a parsed value.
export function jsonColumn(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? parseRubyJson(value) : (value as JsonValue);
}
