// friendly_id 5.5.1 `use: :slugged` as Installment declares it (`friendly_id :slug_candidates`, candidates `[:name, [:name, :id]]`,
// the reserved words of config/initializers/friendly_id.rb). Golden: __fixtures__/save-installment.golden.json.
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

export const RESERVED_WORDS = ["new", "edit", "index", "session", "login", "logout", "users", "admin", "stylesheets", "assets", "javascripts", "images"];

// ActiveSupport's String#parameterize. Names with characters I18n would transliterate are left to Rails.
export function parameterize(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/u.test(value)) throw new NotPortedError("a name that needs I18n transliteration (String#parameterize)", "friendly_id");
  return value
    .replace(/[^a-z0-9\-_]+/giu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

// FriendlyId::Slugged#set_slug for a record whose slug is nil and name is not. `id` is nil for a new record.
export async function generateSlug(tableName: string, name: string, id: number | null, uuid: () => string = randomUUID): Promise<string> {
  const normalized = [name, `${name} ${id ?? ""}`].map(parameterize).filter((candidate) => candidate !== "");
  const candidates = normalized.every((candidate) => RESERVED_WORDS.includes(candidate)) ? normalized : normalized.filter((candidate) => !RESERVED_WORDS.includes(candidate));
  for (const candidate of candidates) {
    const idCondition = id === null ? Prisma.sql`${column(tableName, "id")} IS NOT NULL` : Prisma.sql`${column(tableName, "id")} != ${id}`;
    const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(tableName)} WHERE ${idCondition} AND ${column(tableName, "slug")} = ${candidate} LIMIT 1`);
    if (rows.length === 0) return candidate;
  }
  return [candidates[0], uuid()].filter((part) => part !== undefined).join("-");
}
