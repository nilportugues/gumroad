// Validators whose SQL has to match ActiveRecord 8.1's statement for statement, which the shared
// runtime/validators.ts versions do not yet do (see models/README.md).
import { Prisma } from "@prisma/client";

import type { Callback, CallbackContext } from "../runtime/define-model.ts";
import type { ModelRecord, Row } from "../runtime/record.ts";
import { castRow, column, table } from "../sql.ts";

const ASSOCIATION_CACHE = "associations";

type Cached = { foreignKey: unknown; row: Row | null };

function cache<R extends Row>(record: ModelRecord<R>): Map<string, Cached> {
  let entries = record.ivars[ASSOCIATION_CACHE] as Map<string, Cached> | undefined;
  if (!entries) {
    entries = new Map();
    record.ivars[ASSOCIATION_CACHE] = entries;
  }
  return entries;
}

// What `includes`/inverse_of leave loaded on a record, so validations do not query for it.
export function setAssociation<R extends Row>(record: ModelRecord<R>, name: string, foreignKey: unknown, row: Row | null): void {
  cache(record).set(name, { foreignKey, row });
}

export type BelongsTo = { name: string; foreignKey: string; targetTable: string; targetModel: Prisma.ModelName; primaryKey?: string };

// `record.<association>` for a belongs_to: the loaded target while the foreign key is unchanged,
// else `SELECT target.* FROM target WHERE target.id = ? LIMIT 1` (nil foreign key: no query).
export async function loadBelongsTo<R extends Row>(record: ModelRecord<R>, association: BelongsTo, ctx: CallbackContext): Promise<Row | null> {
  const foreignKey = record.get(association.foreignKey as keyof R & string);
  const cached = cache(record).get(association.name);
  if (cached && cached.foreignKey === foreignKey) return cached.row;
  if (foreignKey == null) return null;
  const pk = association.primaryKey ?? "id";
  const rows = await ctx.tx.$queryRaw<Row[]>(
    Prisma.sql`SELECT ${Prisma.raw(`\`${association.targetTable}\`.*`)} FROM ${table(association.targetTable)} WHERE ${column(association.targetTable, pk)} = ${foreignKey} LIMIT 1`,
  );
  const row = rows[0] ? castRow(association.targetModel, rows[0]) : null;
  setAssociation(record, association.name, foreignKey, row);
  return row;
}

// A required belongs_to under belongs_to_required_validates_foreign_key = true (config/application.rb):
// `validates_presence_of association, message: :required`, which loads the association on every
// save, changed foreign key or not.
export function belongsToRequired<R extends Row>(association: BelongsTo): Callback<R> {
  return {
    name: `belongs_to :${association.name} (required)`,
    async run(record, ctx) {
      if ((await loadBelongsTo(record, association, ctx)) === null) record.errors.add(association.name, "required");
    },
  };
}

// `validates_presence_of :association` on a belongs_to (same lookup, :blank message).
export function validatesAssociationPresence<R extends Row>(association: BelongsTo): Callback<R> {
  return {
    name: `validates_presence_of :${association.name}`,
    async run(record, ctx) {
      if ((await loadBelongsTo(record, association, ctx)) === null) record.errors.add(association.name, "blank");
    },
  };
}

function uniqueIndexes(model: Prisma.ModelName): string[][] {
  const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dmmf) throw new Error(`Unknown Prisma model ${model}`);
  return [...dmmf.uniqueIndexes.map((index) => [...index.fields]), ...dmmf.fields.filter((f) => f.isUnique).map((f) => [f.name])];
}

// UniquenessValidator (activerecord 8.1) with the default case sensitivity: the attribute, then
// `id != ?` for a persisted record, then the scope columns. A persisted record whose attribute
// and scope are unchanged and non-nil skips the query when a unique index covers them.
export function validatesUniqueness<R extends Row>(
  model: Prisma.ModelName,
  tableName: string,
  attribute: keyof R & string,
  opts: { scope?: (keyof R & string)[]; message?: string } = {},
): Callback<R> {
  const scope = opts.scope ?? [];
  const covered = uniqueIndexes(model).some((columns) => columns.every((c) => [...scope, attribute].includes(c as keyof R & string)));
  return {
    name: `validates_uniqueness_of ${attribute}`,
    async run(record, ctx) {
      const attributes = [...scope, attribute];
      const needed = attributes.some((a) => record.attributeChanged(a) || record.get(a) == null) || !covered;
      if (record.persisted && !needed) return;
      const value = record.get(attribute);
      const eq = (name: string, v: unknown) => (v == null ? Prisma.sql`${column(tableName, name)} IS NULL` : Prisma.sql`${column(tableName, name)} = ${v}`);
      const where: Prisma.Sql[] = [eq(attribute, value)];
      if (record.persisted) where.push(Prisma.sql`${column(tableName, "id")} != ${record.get("id" as keyof R & string)}`);
      for (const name of scope) where.push(eq(name, record.get(name)));
      const rows = await ctx.tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 AS one FROM ${table(tableName)} WHERE ${Prisma.join(where, " AND ")} LIMIT 1`);
      if (rows.length > 0) record.errors.add(attribute, "taken", opts.message ? { message: opts.message, value } : { value });
    },
  };
}
