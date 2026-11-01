// ActiveRecord::ConnectionAdapters::MySQL::Quoting#quote (mysql2 escaping for strings), and a
// Prisma.Sql rendered as the statement text Mysql2Adapter sends: prepared_statements is off for
// mysql2, so binds are inlined and that text is also what the query cache keys on.
import { Prisma } from "@prisma/client";

import { MicroDate } from "../concerns/ruby-time.ts";

// quoted_date: the fraction only when there is one. A MicroDate carries its own microseconds.
function formatTime(date: Date): string {
  const iso = date.toISOString();
  const micros = date instanceof MicroDate ? date.microseconds : date.getUTCMilliseconds() * 1000;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${micros > 0 ? `.${String(micros).padStart(6, "0")}` : ""}`;
}

export function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value === true) return "TRUE";
  if (value === false) return "FALSE";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString();
  if (value instanceof Date) return `'${formatTime(value)}'`;
  if (typeof value === "string") {
    const escaped = value.replace(/[\0\n\r\\'"\x1a]/gu, (c) => ({ "\0": "\\0", "\n": "\\n", "\r": "\\r", "\\": "\\\\", "'": "\\'", '"': '\\"', "\x1a": "\\Z" })[c]!);
    return `'${escaped}'`;
  }
  // A value for a JSON column, which ActiveRecord writes as its JSON text.
  if (typeof value === "object") return quote(JSON.stringify(value));
  throw new Error(`cannot quote ${String(value)}`);
}

export function renderSql(sql: Prisma.Sql): string {
  let i = 0;
  return sql.sql.replace(/\?/gu, () => quote(sql.values[i++]));
}
