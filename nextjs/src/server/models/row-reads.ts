// Single-row and has_one reads that models share, each with the statement ActiveRecord sends:
// `belongs_to` / `find_by(id:)` loads, `has_one` loads and `Model.find`.
import { Prisma } from "@prisma/client";

import { RecordNotFound } from "./runtime/errors.ts";
import { castRow, column, quoteName, selectRows, table, tableName } from "./sql.ts";
import { NotPortedError } from "./user.ts";

type Key = bigint | number | string;

const star = (name: string) => Prisma.raw(`${quoteName(name)}.*`);

// `SELECT table.* FROM table WHERE table.<keyColumn> = ? LIMIT 1`, a `belongs_to` load or `find_by`.
// A nil key issues no statement for an association (`nilIssues: false`); `find_by(id: nil)` does.
export async function findOneBy<R extends Record<string, unknown>>(model: Prisma.ModelName, keyColumn: string, key: Key | null, nilIssues = false): Promise<R | null> {
  const name = tableName(model);
  if (key === null && !nilIssues) return null;
  const condition = key === null ? Prisma.sql`${column(name, keyColumn)} IS NULL` : Prisma.sql`${column(name, keyColumn)} = ${key}`;
  const [row] = await selectRows(Prisma.sql`SELECT ${star(name)} FROM ${table(name)} WHERE ${condition} LIMIT 1`);
  return row ? castRow<R>(model, row) : null;
}

export const findById = <R extends Record<string, unknown>>(model: Prisma.ModelName, id: Key | null) => findOneBy<R>(model, "id", id);

// `Model.find(id)`.
export async function findByIdBang<R extends Record<string, unknown>>(model: Prisma.ModelName, id: bigint): Promise<R> {
  const row = await findById<R>(model, id);
  if (!row) throw new RecordNotFound(`Couldn't find ${model} with 'id'=${String(id)}`);
  return row;
}

// A job argument as `Model.find` / `find_by(id:)` take it: an Integer, or the digits of one (the
// column casts the string). Anything else is a Ruby error Node does not reproduce.
export function recordIdFrom(value: unknown, call: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]{1,15}$/u.test(value)) return BigInt(value);
  // JSON.stringify throws on a bigint, an id past 2**53 that Sidekiq's JSON parsed.
  throw new NotPortedError(`${call}(${typeof value === "bigint" ? String(value) : JSON.stringify(value)})`, "the id is not an Integer");
}
